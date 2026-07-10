import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { connectPeer, DEMO_CONTENT, startTestServer, waitFor, type TestPeer } from './helpers';
import type { ShareMdServer } from '../src/server/index';

let server: ShareMdServer;
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

describe('sharemd server', () => {
  test('lists vault documents over HTTP', async () => {
    const response = await fetch(`${server.url}/api/docs`);
    const { docs } = (await response.json()) as { docs: string[] };
    expect(docs).toEqual(['demo.md', 'other.md']);
  });

  test('rejects traversal and non-markdown paths', async () => {
    const traversal = await fetch(`${server.url}/ws/..%2F..%2Fetc%2Fpasswd.md`);
    expect(traversal.status).toBe(400);
    const binary = await fetch(`${server.url}/ws/image.png`);
    expect(binary.status).toBe(400);
  });

  test('hydrates a room from the file on disk', async () => {
    const alice = await peer('demo.md');
    expect(alice.text.toString()).toBe(DEMO_CONTENT);
  });

  test('syncs edits between two peers', async () => {
    const alice = await peer('demo.md');
    const bob = await peer('demo.md');
    alice.text.insert(0, 'alice-was-here\n');
    await waitFor(() => bob.text.toString().startsWith('alice-was-here'), { label: 'bob to see alice' });
    bob.text.insert(bob.text.length, '\nbob-was-here\n');
    await waitFor(() => alice.text.toString().includes('bob-was-here'), { label: 'alice to see bob' });
    expect(alice.text.toString()).toBe(bob.text.toString());
  });

  test('concurrent edits at the same location converge without loss', async () => {
    const alice = await peer('other.md');
    const bob = await peer('other.md');
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
    const onDisk = await Bun.file(join(vaultDir, 'demo.md')).text();
    expect(onDisk).toStartWith('alice-was-here');
    expect(onDisk).toInclude('bob-was-here');
    expect(onDisk).toInclude('# Demo document');
  });

  test('propagates awareness (presence) between peers', async () => {
    const alice = await peer('demo.md');
    const bob = await peer('demo.md');
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
    const alice = await peer('demo.md');
    const bob = await peer('demo.md');
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
