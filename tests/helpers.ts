import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { startServer, type MdioServer } from '../src/server/index';

export const DEMO_CONTENT = `# Demo document

Shared between humans and agents.

## Notes

- First note
- Second note
`;

export async function startTestServer(): Promise<{ server: MdioServer; vaultDir: string }> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'mdio-test-'));
  await Bun.write(join(vaultDir, 'main', 'demo.md'), DEMO_CONTENT);
  await Bun.write(join(vaultDir, 'main', 'other.md'), '# Other\n');
  const server = await startServer({ vaultDir, port: 0 });
  return { server, vaultDir };
}

/** Create a project over the REST API; tolerates it already existing. */
export async function apiCreateProject(server: MdioServer, name: string): Promise<void> {
  const response = await fetch(`${server.url}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`create project ${name}: HTTP ${response.status} ${await response.text()}`);
  }
}

/** Create a document (and its project) over the REST API, as a human would. */
export async function apiCreateDoc(server: MdioServer, docPath: string): Promise<void> {
  const [project, ...rest] = docPath.split('/');
  await apiCreateProject(server, project!);
  const response = await fetch(`${server.url}/api/projects/${encodeURIComponent(project!)}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: rest.join('/') }),
  });
  if (!response.ok) {
    throw new Error(`create doc ${docPath}: HTTP ${response.status} ${await response.text()}`);
  }
}

export interface TestPeer {
  doc: Y.Doc;
  provider: WebsocketProvider;
  text: Y.Text;
  destroy(): void;
}

export async function connectPeer(server: MdioServer, docPath: string): Promise<TestPeer> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://localhost:${server.port}/ws`, docPath, doc, {
    disableBc: true,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('peer sync timeout')), 5000);
    provider.on('sync', (synced: boolean) => {
      if (synced) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    doc,
    provider,
    text: doc.getText('content'),
    destroy() {
      provider.destroy();
      doc.destroy();
    },
  };
}

export function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
