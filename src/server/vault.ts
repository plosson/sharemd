import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { appendFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
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

/** A referenced project or document that isn't there — maps to HTTP 404. */
export class NotFoundError extends Error {}
/** A create/rename target that already exists — maps to HTTP 409. */
export class ConflictError extends Error {}

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
    if (!cleaned.includes(sep)) {
      throw new Error(`Documents live inside a project: ${docPath} (expected <project>/<doc>)`);
    }
    assertProjectName(cleaned.split(sep)[0]!);
    if (!EDITABLE_EXTENSIONS.some((ext) => cleaned.toLowerCase().endsWith(ext))) {
      throw new Error(`Unsupported document type: ${docPath}`);
    }
    const absolute = resolve(this.root, cleaned);
    if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
      throw new Error(`Invalid document path: ${docPath}`);
    }
    return absolute;
  }

  async exists(docPath: string): Promise<boolean> {
    return Bun.file(this.resolvePath(docPath)).exists();
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

  // ── projects ─────────────────────────────────────────────────────────

  private projectDir(name: string): string {
    assertProjectName(name);
    return join(this.root, name);
  }

  private requireProject(name: string): string {
    const dir = this.projectDir(name);
    if (!existsSync(dir)) {
      throw new NotFoundError(`Project "${name}" does not exist.`);
    }
    return dir;
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

  async createProject(name: string): Promise<void> {
    const dir = this.projectDir(name);
    if (existsSync(dir)) {
      throw new ConflictError(`Project "${name}" already exists.`);
    }
    await mkdir(dir, { recursive: true });
  }

  /** Rename a project directory; its sidecar tree under STATE_DIR follows. */
  async renameProject(from: string, to: string): Promise<void> {
    const fromDir = this.requireProject(from);
    const toDir = this.projectDir(to);
    if (existsSync(toDir)) {
      throw new ConflictError(`Project "${to}" already exists.`);
    }
    await rename(fromDir, toDir);
    const fromState = join(this.root, STATE_DIR, from);
    if (existsSync(fromState)) {
      await rename(fromState, join(this.root, STATE_DIR, to));
    }
  }

  /** Delete a project with all its documents and sidecars. */
  async deleteProject(name: string): Promise<void> {
    const dir = this.requireProject(name);
    await rm(dir, { recursive: true });
    await rm(join(this.root, STATE_DIR, name), { recursive: true, force: true });
  }

  // ── documents ────────────────────────────────────────────────────────

  /** Documents of one project, as project-relative paths. */
  async listDocs(project: string): Promise<string[]> {
    const dir = this.requireProject(project);
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const docs: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!EDITABLE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        continue;
      }
      const absolute = join(resolve(entry.parentPath ?? dir), entry.name);
      docs.push(absolute.slice(dir.length + 1).split(sep).join('/'));
    }
    return docs.sort();
  }

  /** Create an empty document; parent folders inside the project are created as needed. */
  async createDoc(docPath: string): Promise<void> {
    const absolute = this.resolvePath(docPath);
    this.requireProject(docPath.split('/')[0]!);
    if (existsSync(absolute)) {
      throw new ConflictError(`Document "${docPath}" already exists.`);
    }
    await Bun.write(absolute, '');
  }

  private requireDoc(docPath: string): string {
    const absolute = this.resolvePath(docPath);
    if (!existsSync(absolute)) {
      throw new NotFoundError(`Document "${docPath}" does not exist.`);
    }
    return absolute;
  }

  /** Delete a document and its sidecars. */
  async deleteDoc(docPath: string): Promise<void> {
    const absolute = this.requireDoc(docPath);
    await rm(absolute);
    await rm(this.stateFile(docPath), { force: true });
    await rm(this.logFile(docPath), { force: true });
  }

  /** Rename/move a document (possibly across projects); sidecars follow. */
  async moveDoc(fromPath: string, toPath: string): Promise<void> {
    const fromAbsolute = this.requireDoc(fromPath);
    const toAbsolute = this.resolvePath(toPath);
    this.requireProject(toPath.split('/')[0]!);
    if (existsSync(toAbsolute)) {
      throw new ConflictError(`Document "${toPath}" already exists.`);
    }
    await mkdir(dirname(toAbsolute), { recursive: true });
    await rename(fromAbsolute, toAbsolute);
    for (const [from, to] of [
      [this.stateFile(fromPath), this.stateFile(toPath)],
      [this.logFile(fromPath), this.logFile(toPath)],
    ] as const) {
      if (existsSync(from)) {
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
      }
    }
  }
}
