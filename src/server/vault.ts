import { readdir } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

const EDITABLE_EXTENSIONS = ['.md', '.markdown', '.txt'];

/** Server-private directory inside the vault holding CRDT state sidecars. */
export const STATE_DIR = '.sharemd';

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
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

  async list(): Promise<string[]> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    const docs: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!EDITABLE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        continue;
      }
      const parent = resolve(entry.parentPath ?? this.root);
      const absolute = join(parent, entry.name);
      const relative = absolute.slice(this.root.length + 1).split(sep).join('/');
      if (relative === STATE_DIR || relative.startsWith(`${STATE_DIR}/`)) {
        continue;
      }
      docs.push(relative);
    }
    return docs.sort();
  }
}
