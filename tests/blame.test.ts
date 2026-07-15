import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { rename, rm } from 'node:fs/promises';
import * as Y from 'yjs';
import { connectPeer, DEMO_CONTENT, startTestServer, waitFor, type TestPeer } from './helpers';
import { startServer, type MdioServer } from '../src/server/index';
import { STATE_DIR } from '../src/server/vault';
import { blameLines, registerAuthor, type BlameLine } from '../src/shared/blame';
import { AgentClient } from './mcp-client';

// DEMO_CONTENT is 8 newline-terminated lines.
const DEMO_LINES = 8;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

async function freshServer(): Promise<{ server: MdioServer; vaultDir: string }> {
  const started = await startTestServer();
  cleanups.push(() => started.server.stop());
  return started;
}

async function restartServer(vaultDir: string): Promise<MdioServer> {
  const server = await startServer({ vaultDir, port: 0 });
  cleanups.push(() => server.stop());
  return server;
}

async function peer(server: MdioServer, docPath: string, name?: string): Promise<TestPeer> {
  const connected = await connectPeer(server, docPath);
  cleanups.push(() => connected.destroy());
  if (name) {
    registerAuthor(connected.doc, { name, role: 'human' });
  }
  return connected;
}

async function spawnAgent(server: MdioServer, name: string): Promise<AgentClient> {
  const agent = await AgentClient.spawn(server.url, name);
  cleanups.push(() => agent.close());
  return agent;
}

async function fetchBlame(server: MdioServer, docPath: string): Promise<BlameLine[]> {
  const [project, ...rest] = docPath.split('/');
  const response = await fetch(`${server.url}/api/projects/${project}/docs/${rest.join('/')}/blame`);
  expect(response.status).toBe(200);
  const { lines } = (await response.json()) as { lines: BlameLine[] };
  return lines;
}

/** The server-side room, so tests can await propagation deterministically. */
async function serverRoom(server: MdioServer, docPath: string) {
  const room = await server.registry.open(docPath);
  return room.doc.getText('content');
}

function authorsOf(line: BlameLine): Record<string, number> {
  return Object.fromEntries(line.authors.map((a) => [a.name, a.chars]));
}

describe('blameLines (unit)', () => {
  function pair(): { a: Y.Doc; b: Y.Doc; sync: () => void } {
    const a = new Y.Doc({ gc: false });
    const b = new Y.Doc({ gc: false });
    const sync = () => {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    };
    return { a, b, sync };
  }

  test('empty document blames to no lines', () => {
    expect(blameLines(new Y.Doc({ gc: false }))).toEqual([]);
  });

  test('attributes interleaved inserts on one line to both peers', () => {
    const { a, b, sync } = pair();
    registerAuthor(a, { name: 'Alice', role: 'human' });
    registerAuthor(b, { name: 'Bob', role: 'agent' });
    a.getText('content').insert(0, 'hello world\n');
    sync();
    b.getText('content').insert(6, 'BOB ');
    sync();

    for (const doc of [a, b]) {
      const lines = blameLines(doc);
      expect(lines).toHaveLength(1);
      expect(authorsOf(lines[0]!)).toEqual({ Alice: 12, Bob: 4 });
    }
  });

  test('only surviving characters are attributed after a cross-peer delete', () => {
    const { a, b, sync } = pair();
    registerAuthor(a, { name: 'Alice' });
    registerAuthor(b, { name: 'Bob' });
    a.getText('content').insert(0, 'keep DELETEME keep\n');
    sync();
    b.getText('content').delete(5, 9); // Bob deletes Alice's "DELETEME "
    sync();

    const lines = blameLines(a);
    expect(a.getText('content').toString()).toBe('keep keep\n');
    expect(authorsOf(lines[0]!)).toEqual({ Alice: 10 });
  });

  test('deleting a whole line removes it and renumbers the rest', () => {
    const { a, b, sync } = pair();
    registerAuthor(a, { name: 'Alice' });
    a.getText('content').insert(0, 'one\ntwo\nthree\n');
    sync();
    b.getText('content').delete(4, 4); // "two\n"
    sync();

    const lines = blameLines(a);
    expect(lines.map((l) => l.line)).toEqual([1, 2]);
    expect(lines[1]!.authors[0]!.chars).toBe('three\n'.length);
  });

  test('aggregates different clientIDs sharing one name', () => {
    const { a, b, sync } = pair();
    registerAuthor(a, { name: 'Alice' });
    registerAuthor(b, { name: 'Alice' });
    a.getText('content').insert(0, 'from-session-1 ');
    sync();
    b.getText('content').insert(15, 'from-session-2');
    sync();

    const lines = blameLines(a);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.authors).toHaveLength(1);
    expect(authorsOf(lines[0]!)).toEqual({ Alice: 29 });
  });

  test('an unregistered client falls back to "unknown"', () => {
    const { a, b, sync } = pair();
    registerAuthor(a, { name: 'Alice' });
    a.getText('content').insert(0, 'signed ');
    sync();
    b.getText('content').insert(7, 'anonymous'); // b never registered
    sync();

    expect(authorsOf(blameLines(a)[0]!)).toEqual({ Alice: 7, unknown: 9 });
  });

  test('counts UTF-16 units and never breaks on astral characters', () => {
    const doc = new Y.Doc({ gc: false });
    registerAuthor(doc, { name: 'Alice' });
    doc.getText('content').insert(0, '🚀🚀\nnext\n');

    const lines = blameLines(doc);
    expect(lines).toHaveLength(2);
    expect(authorsOf(lines[0]!)).toEqual({ Alice: 5 }); // 2 surrogate pairs + newline
    expect(authorsOf(lines[1]!)).toEqual({ Alice: 5 });
  });

  test('a document without a trailing newline still blames its last line', () => {
    const doc = new Y.Doc({ gc: false });
    registerAuthor(doc, { name: 'Alice' });
    doc.getText('content').insert(0, 'a\nno-newline');
    expect(blameLines(doc)).toHaveLength(2);
  });
});

describe('blame over HTTP', () => {
  test('a freshly hydrated file is blamed entirely to "disk"', async () => {
    const { server } = await freshServer();
    const lines = await fetchBlame(server, 'main/demo.md');
    expect(lines).toHaveLength(DEMO_LINES);
    for (const line of lines) {
      expect(line.authors).toHaveLength(1);
      expect(line.authors[0]!.name).toBe('disk');
      expect(line.authors[0]!.role).toBe('system');
    }
    const totalChars = lines.flatMap((l) => l.authors).reduce((sum, a) => sum + a.chars, 0);
    expect(totalChars).toBe(DEMO_CONTENT.length);
  });

  test('a peer edit inside an existing line yields a two-author line', async () => {
    const { server } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert('# Demo'.length, ' EDITED');
    const room = await serverRoom(server, 'main/demo.md');
    await waitFor(() => room.toString().includes('# Demo EDITED'), { label: 'server to see edit' });

    const lines = await fetchBlame(server, 'main/demo.md');
    expect(authorsOf(lines[0]!)).toEqual({ disk: '# Demo document\n'.length, Alice: ' EDITED'.length });
  });

  test('rejects traversal, sidecar-dir, and non-text paths', async () => {
    const { server } = await freshServer();
    for (const bad of [
      `/api/projects/main/docs/..%2F..%2Fsecret.md/blame`, // traversal out of the vault
      `/api/projects/${STATE_DIR}/docs/main%2Fdemo.md.yjs/blame`, // the sidecar dir is not a project
      `/api/projects/main/docs/app.exe/blame`, // not an editable document type
    ]) {
      const response = await fetch(`${server.url}${bad}`);
      expect(response.status).toBe(400);
    }
  });

  test('the sidecar directory never appears in the doc list', async () => {
    const { server } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert(0, 'force a sidecar write\n');
    await server.registry.flushAll();

    const { docs } = (await (await fetch(`${server.url}/api/projects/main/docs`)).json()) as {
      docs: Array<{ path: string }>;
    };
    expect(docs.map((doc) => doc.path)).toEqual(['demo.md', 'other.md']);
    const { projects } = (await (await fetch(`${server.url}/api/projects`)).json()) as { projects: string[] };
    expect(projects).not.toContain(STATE_DIR);
  });
});

describe('blame persistence across restarts', () => {
  test('authorship survives a server restart via the state sidecar', async () => {
    const { server, vaultDir } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert(alice.text.length, 'alice-line\n');
    const room = await serverRoom(server, 'main/demo.md');
    await waitFor(() => room.toString().includes('alice-line'), { label: 'server to see alice' });
    await server.stop();
    cleanups.length = 0; // server stopped explicitly; peers died with it
    alice.destroy();

    expect(await Bun.file(join(vaultDir, STATE_DIR, 'main/demo.md.yjs')).exists()).toBe(true);

    const restarted = await restartServer(vaultDir);
    const lines = await fetchBlame(restarted, 'main/demo.md');
    expect(lines).toHaveLength(DEMO_LINES + 1);
    expect(authorsOf(lines[DEMO_LINES]!)).toEqual({ Alice: 'alice-line\n'.length });
    expect(lines[0]!.authors[0]!.name).toBe('disk');
  });

  test('a pre-rename .sharemd sidecar dir is migrated to STATE_DIR on startup', async () => {
    const { server, vaultDir } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert(alice.text.length, 'alice-line\n');
    const room = await serverRoom(server, 'main/demo.md');
    await waitFor(() => room.toString().includes('alice-line'), { label: 'server to see alice' });
    await server.stop();
    cleanups.length = 0;
    alice.destroy();

    await rename(join(vaultDir, STATE_DIR), join(vaultDir, '.sharemd'));

    const restarted = await restartServer(vaultDir);
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'main/demo.md.yjs')).exists()).toBe(true);
    const lines = await fetchBlame(restarted, 'main/demo.md');
    expect(authorsOf(lines[DEMO_LINES]!)).toEqual({ Alice: 'alice-line\n'.length });
  });

  test('an offline markdown edit is blamed to "disk" without stealing surrounding authorship', async () => {
    const { server, vaultDir } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert(alice.text.length, 'alpha beta gamma\n');
    const room = await serverRoom(server, 'main/demo.md');
    await waitFor(() => room.toString().includes('alpha beta gamma'), { label: 'server to see alice' });
    await server.stop();
    cleanups.length = 0;
    alice.destroy();

    // Offline edit inside Alice's line while the server is down.
    const file = join(vaultDir, 'main/demo.md');
    const offline = (await Bun.file(file).text()).replace('alpha beta gamma', 'alpha BETA gamma');
    await Bun.write(file, offline);

    const restarted = await restartServer(vaultDir);
    const bob = await peer(restarted, 'main/demo.md');
    expect(bob.text.toString()).toBe(offline);

    const lines = await fetchBlame(restarted, 'main/demo.md');
    const aliceLine = lines[DEMO_LINES]!;
    expect(authorsOf(aliceLine)).toEqual({
      Alice: 'alpha '.length + ' gamma\n'.length,
      disk: 'BETA'.length,
    });
  });

  test('a corrupt sidecar falls back to the markdown file instead of crashing', async () => {
    const { server, vaultDir } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert(0, 'alice-was-here\n');
    const room = await serverRoom(server, 'main/demo.md');
    await waitFor(() => room.toString().startsWith('alice-was-here'), { label: 'server to see alice' });
    await server.stop();
    cleanups.length = 0;
    alice.destroy();

    await Bun.write(join(vaultDir, STATE_DIR, 'main/demo.md.yjs'), new Uint8Array([7, 7, 7, 7, 7]));

    const restarted = await restartServer(vaultDir);
    const bob = await peer(restarted, 'main/demo.md');
    expect(bob.text.toString()).toBe(`alice-was-here\n${DEMO_CONTENT}`);
    const lines = await fetchBlame(restarted, 'main/demo.md');
    for (const line of lines) {
      expect(line.authors.map((a) => a.name)).toEqual(['disk']);
    }
  });

  test('a truncated sidecar still serves the markdown content', async () => {
    const { server, vaultDir } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert(0, 'alice-was-here\n');
    const room = await serverRoom(server, 'main/demo.md');
    await waitFor(() => room.toString().startsWith('alice-was-here'), { label: 'server to see alice' });
    await server.stop();
    cleanups.length = 0;
    alice.destroy();

    const sidecarPath = join(vaultDir, STATE_DIR, 'main/demo.md.yjs');
    const sidecar = new Uint8Array(await Bun.file(sidecarPath).arrayBuffer());
    await Bun.write(sidecarPath, sidecar.slice(0, Math.floor(sidecar.length * 0.6)));

    const restarted = await restartServer(vaultDir);
    const bob = await peer(restarted, 'main/demo.md');
    expect(bob.text.toString()).toBe(`alice-was-here\n${DEMO_CONTENT}`);
    const lines = await fetchBlame(restarted, 'main/demo.md');
    expect(lines.flatMap((l) => l.authors).reduce((sum, a) => sum + a.chars, 0)).toBe(
      `alice-was-here\n${DEMO_CONTENT}`.length,
    );
  });

  test('deleting the markdown file offline deletes the document, surviving sidecar or not', async () => {
    const { server, vaultDir } = await freshServer();
    const alice = await peer(server, 'main/demo.md', 'Alice');
    alice.text.insert(0, 'doomed\n');
    const room = await serverRoom(server, 'main/demo.md');
    await waitFor(() => room.toString().startsWith('doomed'), { label: 'server to see alice' });
    await server.stop();
    cleanups.length = 0;
    alice.destroy();

    await rm(join(vaultDir, 'main/demo.md'));

    // The markdown file is the source of truth: no file, no document — the
    // orphaned sidecar must not bring it back.
    const restarted = await restartServer(vaultDir);
    const { docs } = (await (await fetch(`${restarted.url}/api/projects/main/docs`)).json()) as {
      docs: Array<{ path: string }>;
    };
    expect(docs.map((doc) => doc.path)).toEqual(['other.md']);
    expect((await fetch(`${restarted.url}/ws/main/demo.md`)).status).toBe(404);
    expect((await fetch(`${restarted.url}/api/projects/main/docs/demo.md/blame`)).status).toBe(404);
  });
});

describe('blame_document over MCP', () => {
  test('fails with guidance before a document is open', async () => {
    const { server } = await freshServer();
    const agent = await spawnAgent(server, 'Zed');
    const message = await agent.callExpectingError('blame_document');
    expect(message).toInclude('open_document');
  });

  test('an agent sees its own edits attributed by name, hydrated text as "disk"', async () => {
    const { server } = await freshServer();
    const agent = await spawnAgent(server, 'Zed');
    await agent.call('open_document', { path: 'demo.md' });
    await agent.call('insert_text', { text: 'agent wisdom\n' });

    const { lines, lineCount } = await agent.call<{ lines: BlameLine[]; lineCount: number }>(
      'blame_document',
    );
    expect(lineCount).toBe(DEMO_LINES + 1);
    expect(lines[0]!.authors[0]!.name).toBe('disk');
    expect(authorsOf(lines[DEMO_LINES]!)).toEqual({ Zed: 'agent wisdom\n'.length });
  });

  test('windows the result with startLine/maxLines and clamps out-of-range input', async () => {
    const { server } = await freshServer();
    const agent = await spawnAgent(server, 'Zed');
    await agent.call('open_document', { path: 'demo.md' });

    const window = await agent.call<{ lines: BlameLine[]; startLine: number; endLine: number }>(
      'blame_document',
      { startLine: 3, maxLines: 2 },
    );
    expect(window.lines.map((l) => l.line)).toEqual([3, 4]);
    expect(window.endLine).toBe(4);

    const beyond = await agent.call<{ lines: BlameLine[]; startLine: number }>('blame_document', {
      startLine: 999,
    });
    expect(beyond.lines).toEqual([]);
    expect(beyond.startLine).toBe(DEMO_LINES + 1);
  });

  test('a concurrent human deletion shrinks the agent attribution to surviving text', async () => {
    const { server } = await freshServer();
    const agent = await spawnAgent(server, 'Zed');
    await agent.call('open_document', { path: 'demo.md' });
    await agent.call('insert_text', { text: 'agent wisdom\n' });

    const human = await peer(server, 'main/demo.md', 'Hank');
    await waitFor(() => human.text.toString().includes('agent wisdom'), { label: 'human to see agent' });
    const at = human.text.toString().indexOf(' wisdom');
    human.text.delete(at, ' wisdom'.length);

    const deadline = Date.now() + 5000;
    while (true) {
      const { text } = await agent.call<{ text: string }>('read_document');
      if (!text.includes(' wisdom')) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the agent replica to apply the deletion');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const { lines } = await agent.call<{ lines: BlameLine[] }>('blame_document');
    expect(authorsOf(lines[DEMO_LINES]!)).toEqual({ Zed: 'agent\n'.length });
  });
});
