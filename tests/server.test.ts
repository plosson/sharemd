import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { apiCreateDoc, connectPeer, DEMO_CONTENT, startTestServer, waitFor, type TestPeer } from './helpers';
import type { MdioServer } from '../src/server/index';

let server: MdioServer;
let vaultDir: string;
const peers: TestPeer[] = [];

beforeAll(async () => {
  ({ server, vaultDir } = await startTestServer());
});

afterAll(async () => {
  for (const peer of peers) {
    peer.destroy();
  }
  await server.stop();
});

async function peer(docPath: string): Promise<TestPeer> {
  const connected = await connectPeer(server, docPath);
  peers.push(connected);
  return connected;
}

describe('mdio server', () => {
  test('starts with a nonexistent vault directory (fresh deploy)', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const parent = await mkdtemp(join(tmpdir(), 'mdio-fresh-'));
    const { startServer } = await import('../src/server/index');
    const fresh = await startServer({ vaultDir: join(parent, 'does-not-exist-yet'), port: 0 });
    try {
      const response = await fetch(`${fresh.url}/api/projects`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { projects: string[] }).projects).toEqual([]);
    } finally {
      await fresh.stop();
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('lists a project’s documents over HTTP, project-relative with metadata', async () => {
    const response = await fetch(`${server.url}/api/projects/main/docs`);
    const { docs } = (await response.json()) as {
      docs: Array<{ path: string; title: string | null; modified: number }>;
    };
    expect(docs.map((doc) => doc.path)).toEqual(['demo.md', 'other.md']);
    // demo.md opens with a heading; the title is derived from it.
    const demo = docs.find((doc) => doc.path === 'demo.md')!;
    expect(demo.title).toBe('Demo document');
    expect(demo.modified).toBeGreaterThan(0);
    expect(docs.find((doc) => doc.path === 'other.md')!.title).toBe('Other');
  });

  test('rejects traversal and non-markdown paths', async () => {
    const traversal = await fetch(`${server.url}/ws/..%2F..%2Fetc%2Fpasswd.md`);
    expect(traversal.status).toBe(400);
    const binary = await fetch(`${server.url}/ws/image.png`);
    expect(binary.status).toBe(400);
  });

  test('documents must live inside a project, and projects cannot shadow routes', async () => {
    const rootDoc = await fetch(`${server.url}/ws/loose.md`);
    expect(rootDoc.status).toBe(400);
    expect(await rootDoc.text()).toInclude('inside a project');
    const reserved = await fetch(`${server.url}/ws/api%2Fnotes.md`);
    expect(reserved.status).toBe(400);
    expect(await reserved.text()).toInclude('reserved');
  });

  test('connecting never creates a document: /ws for a missing doc is 404', async () => {
    const missing = await fetch(`${server.url}/ws/main/never-created.md`);
    expect(missing.status).toBe(404);
    expect(await Bun.file(join(vaultDir, 'main', 'never-created.md')).exists()).toBe(false);
  });

  test('lists projects; a project created over the API syncs documents', async () => {
    await apiCreateDoc(server, 'specs/plan.md');
    const projects = ((await (await fetch(`${server.url}/api/projects`)).json()) as {
      projects: string[];
    }).projects;
    expect(projects).toContain('main');
    expect(projects).toContain('specs');
    const alice = await peer('specs/plan.md');
    alice.text.insert(0, '# Plan\n');
    const room = await server.registry.open('specs/plan.md');
    await waitFor(() => room.doc.getText('content').toString().startsWith('# Plan'), {
      label: 'server room to receive the edit',
    });
    await server.registry.flushAll();
    expect(await Bun.file(join(vaultDir, 'specs', 'plan.md')).text()).toStartWith('# Plan');
  });

  test('migrates pre-project root documents into the default project', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'mdio-migrate-'));
    await Bun.write(join(dir, 'welcome.md'), '# Welcome\n');
    await Bun.write(join(dir, '.mdio', 'welcome.md.log'), '{"ts":1,"update":"AA=="}\n');
    const { startServer } = await import('../src/server/index');
    const fresh = await startServer({ vaultDir: dir, port: 0 });
    try {
      const { docs } = (await (await fetch(`${fresh.url}/api/projects/main/docs`)).json()) as {
        docs: Array<{ path: string }>;
      };
      expect(docs.map((doc) => doc.path)).toEqual(['welcome.md']);
      expect(await Bun.file(join(dir, 'main', 'welcome.md')).text()).toBe('# Welcome\n');
      expect(await Bun.file(join(dir, '.mdio', 'main', 'welcome.md.log')).exists()).toBe(true);
    } finally {
      await fresh.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('hydrates a room from the file on disk', async () => {
    const alice = await peer('main/demo.md');
    expect(alice.text.toString()).toBe(DEMO_CONTENT);
  });

  test('syncs edits between two peers', async () => {
    const alice = await peer('main/demo.md');
    const bob = await peer('main/demo.md');
    alice.text.insert(0, 'alice-was-here\n');
    await waitFor(() => bob.text.toString().startsWith('alice-was-here'), { label: 'bob to see alice' });
    bob.text.insert(bob.text.length, '\nbob-was-here\n');
    await waitFor(() => alice.text.toString().includes('bob-was-here'), { label: 'alice to see bob' });
    expect(alice.text.toString()).toBe(bob.text.toString());
  });

  test('concurrent edits at the same location converge without loss', async () => {
    const alice = await peer('main/other.md');
    const bob = await peer('main/other.md');
    const end = alice.text.length;
    alice.text.insert(end, 'from-alice\n');
    bob.text.insert(end, 'from-bob\n');
    await waitFor(
      () =>
        alice.text.toString() === bob.text.toString() &&
        alice.text.toString().includes('from-alice') &&
        alice.text.toString().includes('from-bob'),
      { label: 'convergence with both edits' },
    );
  });

  test('persists the merged document back to disk (debounced)', async () => {
    await waitFor(() => false, { timeoutMs: 700, label: 'debounce window' }).catch(() => {});
    await server.registry.flushAll();
    const onDisk = await Bun.file(join(vaultDir, 'main/demo.md')).text();
    expect(onDisk).toStartWith('alice-was-here');
    expect(onDisk).toInclude('bob-was-here');
    expect(onDisk).toInclude('# Demo document');
  });

  test('propagates awareness (presence) between peers', async () => {
    const alice = await peer('main/demo.md');
    const bob = await peer('main/demo.md');
    alice.provider.awareness.setLocalStateField('user', { name: 'Alice', color: '#ff0000' });
    await waitFor(
      () =>
        [...bob.provider.awareness.getStates().values()].some(
          (state) => (state as { user?: { name?: string } }).user?.name === 'Alice',
        ),
      { label: 'bob to see alice presence' },
    );
  });

  test('removes presence when a peer disconnects', async () => {
    const alice = await peer('main/demo.md');
    const bob = await peer('main/demo.md');
    alice.provider.awareness.setLocalStateField('user', { name: 'Ghost', color: '#000' });
    await waitFor(
      () =>
        [...bob.provider.awareness.getStates().values()].some(
          (state) => (state as { user?: { name?: string } }).user?.name === 'Ghost',
        ),
      { label: 'ghost presence to appear' },
    );
    alice.destroy();
    await waitFor(
      () =>
        ![...bob.provider.awareness.getStates().values()].some(
          (state) => (state as { user?: { name?: string } }).user?.name === 'Ghost',
        ),
      { label: 'ghost presence to disappear' },
    );
  });
});
