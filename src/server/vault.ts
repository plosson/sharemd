import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

const EDITABLE_EXTENSIONS = ['.md', '.markdown', '.txt'];

/** Server-private directory inside the vault holding CRDT state sidecars. */
export const STATE_DIR = '.mdio';
/** Pre-rename sidecar directory, migrated to STATE_DIR on first open. */
const LEGACY_STATE_DIR = '.sharemd';

/** Project pre-projects vaults' root documents migrate into. */
export const DEFAULT_PROJECT = 'main';

/** Route names the web server claims — a project cannot shadow them. */
const RESERVED_PROJECT_NAMES = new Set(['api', 'ws', 'app.js', 'styles.css', 'install.sh', 'install.ps1']);

/** Validate a project name (a single top-level directory segment). */
export function assertProjectName(name: string): void {
  if (!name || /[/\\]/.test(name) || /\s/.test(name)) {
    throw new Error(`Invalid project name: "${name}" — one directory name, no slashes or spaces.`);
  }
  if (name.startsWith('.') || RESERVED_PROJECT_NAMES.has(name.toLowerCase())) {
    throw new Error(`"${name}" is a reserved name — pick another project name.`);
  }
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    // One-shot migration: vaults written before the mdio rename keep their
    // blame/comment/history sidecars under the old directory name.
    const legacy = join(this.root, LEGACY_STATE_DIR);
    if (existsSync(legacy) && !existsSync(join(this.root, STATE_DIR))) {
      renameSync(legacy, join(this.root, STATE_DIR));
    }
    this.migrateRootDocs();
  }

  /**
   * One-shot migration: pre-projects vaults kept documents at the root; move
   * them (and their sidecars) into the default project. Root subdirectories
   * already are projects and stay untouched.
   */
  private migrateRootDocs(): void {
    if (!existsSync(this.root)) {
      return;
    }
    const rootDocs = readdirSync(this.root, { withFileTypes: true }).filter(
      (entry) =>
        entry.isFile() && EDITABLE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)),
    );
    if (rootDocs.length === 0) {
      return;
    }
    mkdirSync(join(this.root, DEFAULT_PROJECT), { recursive: true });
    for (const entry of rootDocs) {
      renameSync(join(this.root, entry.name), join(this.root, DEFAULT_PROJECT, entry.name));
      for (const suffix of ['.yjs', '.log']) {
        const sidecar = join(this.root, STATE_DIR, `${entry.name}${suffix}`);
        if (existsSync(sidecar)) {
          mkdirSync(join(this.root, STATE_DIR, DEFAULT_PROJECT), { recursive: true });
          renameSync(sidecar, join(this.root, STATE_DIR, DEFAULT_PROJECT, `${entry.name}${suffix}`));
        }
      }
    }
  }

  /** Resolve a vault-relative document path, rejecting traversal and non-text files. */
  resolvePath(docPath: string): string {
    const cleaned = normalize(docPath).replace(/^([/\\])+/, '');
    if (cleaned.startsWith('..') || cleaned.includes(`..${sep}`)) {
      throw new Error(`Invalid document path: ${docPath}`);
    }
    if (cleaned === STATE_DIR || cleaned.startsWith(`${STATE_DIR}${sep}`)) {
      throw new Error(`Invalid document path: ${docPath}`);
    }
    const project = cleaned.split(sep)[0]!;
    if (!cleaned.includes(sep)) {
      throw new Error(`Documents live inside a project: ${docPath} (expected <project>/<doc>)`);
    }
    if (project.startsWith('.') || RESERVED_PROJECT_NAMES.has(project.toLowerCase())) {
      throw new Error(`"${project}" is a reserved name — pick another project name.`);
    }
    if (!EDITABLE_EXTENSIONS.some((ext) => cleaned.toLowerCase().endsWith(ext))) {
      throw new Error(`Unsupported document type: ${docPath}`);
    }
    const absolute = resolve(this.root, cleaned);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
      throw new Error(`Invalid document path: ${docPath}`);
    }
    return absolute;
  }

  async read(docPath: string): Promise<string | null> {
    const file = Bun.file(this.resolvePath(docPath));
    if (!(await file.exists())) {
      return null;
    }
    return file.text();
  }

  async write(docPath: string, content: string): Promise<void> {
    await Bun.write(this.resolvePath(docPath), content);
  }

  /** Absolute path of the CRDT state sidecar mirroring a document path under STATE_DIR. */
  private stateFile(docPath: string): string {
    const relative = this.resolvePath(docPath).slice(this.root.length + 1);
    return join(this.root, STATE_DIR, `${relative}.yjs`);
  }

  async readState(docPath: string): Promise<Uint8Array | null> {
    const file = Bun.file(this.stateFile(docPath));
    if (!(await file.exists())) {
      return null;
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeState(docPath: string, state: Uint8Array): Promise<void> {
    await Bun.write(this.stateFile(docPath), state);
  }

  /** Absolute path of the append-only update log mirroring a document path under STATE_DIR. */
  private logFile(docPath: string): string {
    const relative = this.resolvePath(docPath).slice(this.root.length + 1);
    return join(this.root, STATE_DIR, `${relative}.log`);
  }

  /** Raw NDJSON history log ("" when absent) — one {ts, update} entry per line. */
  async readLog(docPath: string): Promise<string> {
    const file = Bun.file(this.logFile(docPath));
    if (!(await file.exists())) {
      return '';
    }
    return file.text();
  }

  async appendLog(docPath: string, ts: number, update: Uint8Array): Promise<void> {
    const line = `${JSON.stringify({ ts, update: Buffer.from(update).toString('base64') })}\n`;
    const path = this.logFile(docPath);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line);
  }

  /** Restart the log with a single full-state entry (fresh doc, or unusable existing log). */
  async resetLog(docPath: string, ts: number, state: Uint8Array): Promise<void> {
    const line = `${JSON.stringify({ ts, update: Buffer.from(state).toString('base64') })}\n`;
    await Bun.write(this.logFile(docPath), line);
  }

  async list(project?: string): Promise<string[]> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    const docs: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const parent = resolve(entry.parentPath ?? this.root);
      const absolute = join(parent, entry.name);
      const relative = absolute.slice(this.root.length + 1).split(sep).join('/');
      try {
        this.resolvePath(relative); // skips sidecars, root strays, reserved names
      } catch {
        continue;
      }
      if (project !== undefined && !relative.startsWith(`${project}/`)) {
        continue;
      }
      docs.push(relative);
    }
    return docs.sort();
  }

  /** Top-level directories are projects; every document lives inside one. */
  async listProjects(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !RESERVED_PROJECT_NAMES.has(entry.name.toLowerCase()),
      )
      .map((entry) => entry.name)
      .sort();
  }
}
