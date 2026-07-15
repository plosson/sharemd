import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { apiCreateDoc, apiCreateProject, connectPeer, startTestServer, waitFor, type TestPeer } from './helpers';
import { registerAuthor } from '../src/shared/blame';
import { STATE_DIR } from '../src/server/vault';
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

function call(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${server.url}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function peer(docPath: string): Promise<TestPeer> {
  const connected = await connectPeer(server, docPath);
  peers.push(connected);
  return connected;
}

/** Let the server room see what a peer wrote (in-process registry access). */
async function serverSaw(docPath: string, needle: string): Promise<void> {
  const room = await server.registry.open(docPath);
  await waitFor(() => room.doc.getText('content').toString().includes(needle), {
    label: `server room to contain "${needle}"`,
  });
}

async function projectList(): Promise<string[]> {
  return (((await (await call('GET', '/api/projects')).json()) as { projects: string[] }).projects);
}

async function docList(project: string): Promise<string[]> {
  return (((await (await call('GET', `/api/projects/${project}/docs`)).json()) as { docs: string[] }).docs);
}

describe('project CRUD', () => {
  test('create: 201, listed, directory exists', async () => {
    const response = await call('POST', '/api/projects', { name: 'created' });
    expect(response.status).toBe(201);
    expect(await projectList()).toContain('created');
    expect(await docList('created')).toEqual([]);
  });

  test('create: duplicate is 409', async () => {
    await apiCreateProject(server, 'twice');
    const response = await call('POST', '/api/projects', { name: 'twice' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toInclude('already exists');
  });

  test('create: reserved and malformed names are 400', async () => {
    for (const name of ['api', 'ws', 'app.js', 'install.sh', 'API', '.hidden', 'a/b', 'a\\b', 'a b', '..', '']) {
      const response = await call('POST', '/api/projects', { name });
      expect(response.status).toBe(400);
    }
    const noBody = await call('POST', '/api/projects');
    expect(noBody.status).toBe(400);
    const wrongType = await call('POST', '/api/projects', { name: 42 });
    expect(wrongType.status).toBe(400);
  });

  test('rename: documents, sidecars, and unpersisted edits move along', async () => {
    await apiCreateDoc(server, 'draft/notes.md');
    const alice = await peer('draft/notes.md');
    alice.text.insert(0, '# Notes by alice\n');
    await serverSaw('draft/notes.md', '# Notes by alice');
    // No flush: the debounced persist has not fired — rename must flush first.
    const response = await call('PATCH', '/api/projects/draft', { name: 'final' });
    expect(response.status).toBe(200);
    expect(await projectList()).not.toContain('draft');
    expect(await docList('final')).toEqual(['notes.md']);
    expect(await Bun.file(join(vaultDir, 'final', 'notes.md')).text()).toInclude('# Notes by alice');
    // Sidecars followed: blame at the new location still knows the content.
    const blame = await call('GET', '/api/projects/final/docs/notes.md/blame');
    expect(blame.status).toBe(200);
    // The old project is gone entirely.
    expect((await call('GET', '/api/projects/draft/docs')).status).toBe(404);
    expect(await Bun.file(join(vaultDir, 'draft', 'notes.md')).exists()).toBe(false);
  });

  test('rename: missing is 404, existing target is 409, reserved target is 400', async () => {
    expect((await call('PATCH', '/api/projects/no-such-project', { name: 'x' })).status).toBe(404);
    await apiCreateProject(server, 'occupied');
    await apiCreateProject(server, 'mover');
    expect((await call('PATCH', '/api/projects/mover', { name: 'occupied' })).status).toBe(409);
    expect((await call('PATCH', '/api/projects/mover', { name: 'api' })).status).toBe(400);
    expect((await call('PATCH', '/api/projects/mover', { name: '' })).status).toBe(400);
  });

  test('delete: project, documents, and sidecars are gone; peers cannot resurrect them', async () => {
    await apiCreateDoc(server, 'doomed/gone.md');
    const ghost = await peer('doomed/gone.md');
    ghost.text.insert(0, 'about to vanish');
    await serverSaw('doomed/gone.md', 'about to vanish');
    await server.registry.flushAll(); // sidecars exist on disk now
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'doomed', 'gone.md.yjs')).exists()).toBe(true);

    const response = await call('DELETE', '/api/projects/doomed');
    expect(response.status).toBe(204);
    expect(await projectList()).not.toContain('doomed');
    expect(await Bun.file(join(vaultDir, 'doomed', 'gone.md')).exists()).toBe(false);
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'doomed', 'gone.md.yjs')).exists()).toBe(false);

    // Adversarial: the still-running client keeps typing. Its room is closed
    // server-side, so nothing may reappear on disk — not even after the old
    // debounce window and a global flush.
    ghost.text.insert(0, 'necromancy');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await server.registry.flushAll();
    expect(await Bun.file(join(vaultDir, 'doomed', 'gone.md')).exists()).toBe(false);
    // Reconnecting to the dead room is refused — the doc is not recreated.
    expect((await fetch(`${server.url}/ws/doomed/gone.md`)).status).toBe(404);
  });

  test('delete: missing is 404; unsupported methods are 405', async () => {
    expect((await call('DELETE', '/api/projects/no-such-project')).status).toBe(404);
    expect((await call('PUT', '/api/projects')).status).toBe(405);
    expect((await call('PUT', '/api/projects/main')).status).toBe(405);
  });
});

describe('document CRUD', () => {
  test('create: 201, empty on disk, listed, and openable over ws', async () => {
    await apiCreateProject(server, 'papers');
    const response = await call('POST', '/api/projects/papers/docs', { path: 'intro.md' });
    expect(response.status).toBe(201);
    expect(await docList('papers')).toEqual(['intro.md']);
    expect(await Bun.file(join(vaultDir, 'papers', 'intro.md')).text()).toBe('');
    const alice = await peer('papers/intro.md');
    alice.text.insert(0, 'hello');
    await serverSaw('papers/intro.md', 'hello');
  });

  test('create: nested paths create their folders', async () => {
    await call('POST', '/api/projects/papers/docs', { path: 'sub/section/deep.md' });
    expect(await docList('papers')).toContain('sub/section/deep.md');
  });

  test('create: duplicate 409, missing project 404, bad paths 400', async () => {
    expect((await call('POST', '/api/projects/papers/docs', { path: 'intro.md' })).status).toBe(409);
    expect((await call('POST', '/api/projects/no-such-project/docs', { path: 'x.md' })).status).toBe(404);
    for (const path of ['nope.exe', 'nope', '../escape.md', '..\\escape.md', '', '/etc/passwd.md']) {
      const response = await call('POST', '/api/projects/papers/docs', { path });
      expect(response.status).toBe(400);
    }
    expect((await call('POST', '/api/projects/papers/docs', { path: 42 })).status).toBe(400);
  });

  test('rename: content, blame, and history survive; the old path dies', async () => {
    await apiCreateDoc(server, 'library/old-name.md');
    const alice = await peer('library/old-name.md');
    alice.text.insert(0, '# Kept across rename\n');
    await serverSaw('library/old-name.md', '# Kept across rename');
    // Unpersisted on purpose: rename must flush before moving files.
    const response = await call('PATCH', '/api/projects/library/docs/old-name.md', { path: 'new-name.md' });
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toEqual({ project: 'library', path: 'new-name.md' });
    expect(await docList('library')).toEqual(['new-name.md']);
    expect(await Bun.file(join(vaultDir, 'library', 'new-name.md')).text()).toInclude('# Kept across rename');
    expect(await Bun.file(join(vaultDir, 'library', 'old-name.md')).exists()).toBe(false);

    // History and blame carried over with the sidecars.
    const history = await call('GET', '/api/projects/library/docs/new-name.md/history');
    expect(history.status).toBe(200);
    expect((await history.text()).trim().length).toBeGreaterThan(0);
    const blame = await call('GET', '/api/projects/library/docs/new-name.md/blame');
    expect(blame.status).toBe(200);

    // The old path is dead for every access mode.
    expect((await fetch(`${server.url}/ws/library/old-name.md`)).status).toBe(404);
    expect((await call('GET', '/api/projects/library/docs/old-name.md/history')).status).toBe(404);
    expect((await call('PATCH', '/api/projects/library/docs/old-name.md', { path: 'z.md' })).status).toBe(404);
  });

  test('move across projects: sidecars follow, source project keeps the rest', async () => {
    await apiCreateDoc(server, 'source/stay.md');
    await apiCreateDoc(server, 'source/travel.md');
    await apiCreateProject(server, 'destination');
    const alice = await peer('source/travel.md');
    alice.text.insert(0, 'suitcase');
    await serverSaw('source/travel.md', 'suitcase');
    await server.registry.flushAll();

    const response = await call('PATCH', '/api/projects/source/docs/travel.md', { project: 'destination' });
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toEqual({ project: 'destination', path: 'travel.md' });
    expect(await docList('source')).toEqual(['stay.md']);
    expect(await docList('destination')).toEqual(['travel.md']);
    expect(await Bun.file(join(vaultDir, 'destination', 'travel.md')).text()).toInclude('suitcase');
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'destination', 'travel.md.yjs')).exists()).toBe(true);
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'source', 'travel.md.yjs')).exists()).toBe(false);
  });

  test('move: rename and relocation in one call', async () => {
    await apiCreateDoc(server, 'combo/a.md');
    await apiCreateProject(server, 'combo-target');
    const response = await call('PATCH', '/api/projects/combo/docs/a.md', {
      project: 'combo-target',
      path: 'renamed/b.md',
    });
    expect(response.status).toBe(200);
    expect(await docList('combo-target')).toEqual(['renamed/b.md']);
  });

  test('move: conflicts and bad targets', async () => {
    await apiCreateDoc(server, 'clash/one.md');
    await apiCreateDoc(server, 'clash/two.md');
    expect((await call('PATCH', '/api/projects/clash/docs/one.md', { path: 'two.md' })).status).toBe(409);
    expect((await call('PATCH', '/api/projects/clash/docs/one.md', { project: 'no-such-project' })).status).toBe(404);
    expect((await call('PATCH', '/api/projects/clash/docs/one.md', { path: '../escape.md' })).status).toBe(400);
    expect((await call('PATCH', '/api/projects/clash/docs/one.md', { path: 'binary.exe' })).status).toBe(400);
    expect((await call('PATCH', '/api/projects/clash/docs/one.md', { path: 42 })).status).toBe(400);
    // No-op PATCH is fine and changes nothing.
    const noop = await call('PATCH', '/api/projects/clash/docs/one.md', {});
    expect(noop.status).toBe(200);
    expect(await docList('clash')).toEqual(['one.md', 'two.md']);
  });

  test('delete: file and sidecars are gone; a live peer cannot resurrect the doc', async () => {
    await apiCreateDoc(server, 'shred/secret.md');
    const ghost = await peer('shred/secret.md');
    ghost.text.insert(0, 'classified');
    await serverSaw('shred/secret.md', 'classified');
    await server.registry.flushAll();
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'shred', 'secret.md.yjs')).exists()).toBe(true);

    const response = await call('DELETE', '/api/projects/shred/docs/secret.md');
    expect(response.status).toBe(204);
    expect(await docList('shred')).toEqual([]);
    expect(await Bun.file(join(vaultDir, 'shred', 'secret.md')).exists()).toBe(false);
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'shred', 'secret.md.yjs')).exists()).toBe(false);
    expect(await Bun.file(join(vaultDir, STATE_DIR, 'shred', 'secret.md.log')).exists()).toBe(false);

    ghost.text.insert(0, 'leak attempt');
    await new Promise((resolve) => setTimeout(resolve, 600));
    await server.registry.flushAll();
    expect(await Bun.file(join(vaultDir, 'shred', 'secret.md')).exists()).toBe(false);
    expect((await fetch(`${server.url}/ws/shred/secret.md`)).status).toBe(404);
  });

  test('delete: unsaved edits are discarded, not flushed to disk first', async () => {
    await apiCreateDoc(server, 'discard/pending.md');
    const alice = await peer('discard/pending.md');
    alice.text.insert(0, 'must never hit disk');
    await serverSaw('discard/pending.md', 'must never hit disk');
    // Delete inside the debounce window: the pending persist must be dropped.
    expect((await call('DELETE', '/api/projects/discard/docs/pending.md')).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await Bun.file(join(vaultDir, 'discard', 'pending.md')).exists()).toBe(false);
  });

  test('delete: missing is 404; history/blame of missing docs are 404', async () => {
    expect((await call('DELETE', '/api/projects/main/docs/no-such.md')).status).toBe(404);
    expect((await call('GET', '/api/projects/main/docs/no-such.md/history')).status).toBe(404);
    expect((await call('GET', '/api/projects/main/docs/no-such.md/blame')).status).toBe(404);
  });
});

interface SnapshotMeta {
  id: string;
  label: string;
  author: string;
  ts: number;
  state?: string;
}

async function snapshotList(docUrl: string): Promise<SnapshotMeta[]> {
  const response = await call('GET', `${docUrl}/snapshots`);
  return ((await response.json()) as { snapshots: SnapshotMeta[] }).snapshots;
}

describe('document snapshots', () => {
  test('capture → edit → restore converges the text back, authored to the restorer', async () => {
    await apiCreateDoc(server, 'versions/notes.md');
    const url = '/api/projects/versions/docs/notes.md';
    const alice = await peer('versions/notes.md');
    alice.text.insert(0, 'VERSION ONE\n');
    await serverSaw('versions/notes.md', 'VERSION ONE');

    // Capturing returns metadata (never the heavy state blob) and requires a label.
    expect((await call('POST', `${url}/snapshots`, {})).status).toBe(400);
    const created = await call('POST', `${url}/snapshots`, { label: 'first draft', author: 'plosson' });
    expect(created.status).toBe(201);
    const snapshot = (await created.json()) as SnapshotMeta;
    expect(snapshot.label).toBe('first draft');
    expect(snapshot.author).toBe('plosson');
    expect(snapshot.state).toBeUndefined();
    expect(await snapshotList(url)).toHaveLength(1);

    // Move on: the text diverges.
    alice.text.delete(0, alice.text.length);
    alice.text.insert(0, 'VERSION TWO — rewritten\n');
    await serverSaw('versions/notes.md', 'VERSION TWO');

    // Restore pulls the live document back to the captured text, for every peer.
    const restored = await call('POST', `${url}/snapshots/${snapshot.id}/restore`, { author: 'plosson' });
    expect(restored.status).toBe(200);
    await waitFor(() => alice.text.toString() === 'VERSION ONE\n', { label: 'restore to reach the peer' });

    // The restore is an authored edit — plosson shows up in blame.
    const blame = (await (await call('GET', `${url}/blame`)).json()) as {
      lines: Array<{ authors: Array<{ name: string }> }>;
    };
    expect(blame.lines.some((line) => line.authors.some((a) => a.name === 'plosson'))).toBe(true);
  });

  test('the snapshots sidecar travels on move and is removed on delete', async () => {
    await apiCreateDoc(server, 'versions/movable.md');
    const url = '/api/projects/versions/docs/movable.md';
    await peer('versions/movable.md'); // hydrate a room so capture has live state
    await call('POST', `${url}/snapshots`, { label: 'keep me' });
    const sidecar = join(vaultDir, STATE_DIR, 'versions', 'movable.md.snapshots.json');
    expect(await Bun.file(sidecar).exists()).toBe(true);

    // Rename within the project: the snapshot follows to the new path.
    expect((await call('PATCH', url, { path: 'renamed.md' })).status).toBe(200);
    const movedUrl = '/api/projects/versions/docs/renamed.md';
    expect((await snapshotList(movedUrl)).map((s) => s.label)).toEqual(['keep me']);
    expect(await Bun.file(sidecar).exists()).toBe(false);

    // Delete: the sidecar goes with the document.
    expect((await call('DELETE', movedUrl)).status).toBe(204);
    const movedSidecar = join(vaultDir, STATE_DIR, 'versions', 'renamed.md.snapshots.json');
    expect(await Bun.file(movedSidecar).exists()).toBe(false);
  });

  test('restore never re-attributes text it did not touch', async () => {
    // Content that reaches the room from disk is blamed to "disk" at hydrate —
    // written to the file before the room ever opens.
    await apiCreateDoc(server, 'versions/blamed.md');
    await Bun.write(join(vaultDir, 'versions', 'blamed.md'), 'DISK LINE ONE\nDISK LINE TWO\n');
    const url = '/api/projects/versions/docs/blamed.md';
    const blameNames = async () =>
      ((await (await call('GET', `${url}/blame`)).json()) as {
        lines: Array<{ authors: Array<{ name: string }> }>;
      }).lines.map((line) => line.authors.map((a) => a.name));
    expect(await blameNames()).toEqual([['disk'], ['disk']]);

    // Checkpoint, then Alice rewrites line two.
    const created = await call('POST', `${url}/snapshots`, { label: 'v1', author: 'plosson' });
    const { id } = (await created.json()) as { id: string };
    const alice = await peer('versions/blamed.md');
    registerAuthor(alice.doc, { name: 'Alice', role: 'human' });
    const at = alice.text.toString().indexOf('DISK LINE TWO');
    alice.text.delete(at, 'DISK LINE TWO'.length);
    alice.text.insert(at, 'ALICE LINE TWO');
    await serverSaw('versions/blamed.md', 'ALICE LINE TWO');

    // Restore as plosson. The room doc's own clientID belongs to the "disk"
    // reconcile, so a restore registering the restorer under that ID would
    // retroactively flip line one to "plosson" — the regression this guards.
    expect((await call('POST', `${url}/snapshots/${id}/restore`, { author: 'plosson' })).status).toBe(200);
    const lines = await blameNames();
    expect(lines[0]).toEqual(['disk']); // untouched by the restore: still disk's
    expect(lines[1]).toContain('plosson'); // the re-added text is the restorer's
  });

  test('restoring a missing snapshot is 404', async () => {
    await apiCreateDoc(server, 'versions/x.md');
    const response = await call('POST', '/api/projects/versions/docs/x.md/snapshots/s-nope/restore', {});
    expect(response.status).toBe(404);
  });
});

describe('project search', () => {
  test('searches on-disk content, stays within the project, reports line + snippet', async () => {
    await apiCreateDoc(server, 'searchp/one.md');
    await Bun.write(join(vaultDir, 'searchp', 'one.md'), '# Title\n\nplease FINDME on disk\n');
    // A different project with the same term must not leak into the results.
    await apiCreateDoc(server, 'searchq/two.md');
    await Bun.write(join(vaultDir, 'searchq', 'two.md'), 'FINDME elsewhere\n');

    const response = await call('GET', '/api/projects/searchp/search?q=findme');
    expect(response.status).toBe(200);
    const { matches } = (await response.json()) as {
      matches: Array<{ doc: string; line: number; column: number; snippet: string }>;
    };
    expect(matches).toHaveLength(1);
    expect(matches[0]!.doc).toBe('one.md');
    expect(matches[0]!.line).toBe(3);
    expect(matches[0]!.column).toBe(8); // 1-based column of "FINDME"
    expect(matches[0]!.snippet).toInclude('FINDME');
  });

  test('missing query is 400; unknown project is 404', async () => {
    await apiCreateDoc(server, 'searchp/y.md');
    expect((await call('GET', '/api/projects/searchp/search')).status).toBe(400);
    expect((await call('GET', '/api/projects/no-such-project/search?q=x')).status).toBe(404);
  });
});
