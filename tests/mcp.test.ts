import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { connectPeer, startTestServer, waitFor, type TestPeer } from './helpers';
import { parseUsername, resolveIdentity } from '../src/mcp/identity';
import type { MdioServer } from '../src/server/index';
import { AgentClient } from './mcp-client';

let server: MdioServer;
let vaultDir: string;
let agent: AgentClient;
let observer: TestPeer;

beforeAll(async () => {
  ({ server, vaultDir } = await startTestServer());
  agent = await AgentClient.spawn(server.url, 'plosson/alice');
  observer = await connectPeer(server, 'main/demo.md');
});

afterAll(async () => {
  await agent.close();
  observer.destroy();
  await server.stop();
});

const content = () => observer.text.toString();

/** Poll an async source until its value satisfies the predicate (peer sync races). */
async function eventually<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    last = await fn();
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

describe('mdio MCP', () => {
  test('exposes the agreed tool surface', async () => {
    expect(await agent.listTools()).toEqual([
      'abort_edit',
      'add_comment',
      'append_text',
      'begin_edit',
      'blame_document',
      'commit_edit',
      'delete_comment',
      'delete_range',
      'edit_comment',
      'insert_text',
      'list_comments',
      'list_documents',
      'open_document',
      'place_cursor',
      'read_document',
      'replace_match',
      'replace_text',
      'reply_comment',
      'resolve_comment',
      'search_text',
    ]);
  });

  test('list_documents returns the project, with project-relative paths', async () => {
    const { project, docs } = await agent.call<{ project: string; docs: string[] }>('list_documents');
    expect(project).toBe('main');
    expect(docs).toEqual(['demo.md', 'other.md']);
  });

  test('the peer is fenced into its project: no other project is visible or reachable', async () => {
    const stranger = await connectPeer(server, 'secret/hidden.md');
    stranger.text.insert(0, '# Hidden\n');
    await server.registry.flushAll();
    stranger.destroy();

    const { docs } = await agent.call<{ docs: string[] }>('list_documents');
    expect(docs).not.toContain('secret/hidden.md');
    const escape = await agent.callExpectingError('open_document', { path: '../secret/hidden.md' });
    expect(escape).toInclude('relative to your project');
  });

  test('tools before open_document fail with guidance', async () => {
    const message = await agent.callExpectingError('read_document');
    expect(message).toInclude('open_document');
  });

  test('open_document + read_document return live content', async () => {
    const opened = await agent.call<{ path: string; charCount: number }>('open_document', {
      path: 'demo.md',
    });
    expect(opened.path).toBe('demo.md');
    expect(opened.charCount).toBeGreaterThan(0);
    const read = await agent.call<{ text: string }>('read_document');
    expect(read.text).toInclude('# Demo document');
  });

  test('an owner-scoped username joins with role=agent', async () => {
    await waitFor(
      () =>
        [...observer.provider.awareness.getStates().values()].some(
          (state) =>
            (state as { user?: { name?: string; role?: string } }).user?.name === 'plosson/alice' &&
            (state as { user?: { role?: string } }).user?.role === 'agent',
        ),
      { label: 'agent presence' },
    );
  });

  test('a slash-free username joins the room as a human peer', async () => {
    const humanMcp = await AgentClient.spawn(server.url, 'hank');
    try {
      await humanMcp.call('open_document', { path: 'demo.md' });
      await waitFor(
        () =>
          [...observer.provider.awareness.getStates().values()].some(
            (state) =>
              (state as { user?: { name?: string; role?: string } }).user?.name === 'hank' &&
              (state as { user?: { role?: string } }).user?.role === 'human',
          ),
        { label: 'human-over-MCP presence' },
      );
    } finally {
      await humanMcp.close();
    }
  });

  test('search_text returns match handles with context', async () => {
    const { matches } = await agent.call<{ matches: Array<{ matchId: string; text: string; before: string }> }>(
      'search_text',
      { query: 'Second note' },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.before).toInclude('First note');
  });

  test('place_cursor + insert_text edit at an anchored location', async () => {
    const { matches } = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: '- Second note',
    });
    await agent.call('place_cursor', { matchId: matches[0]!.matchId, edge: 'end' });
    await agent.call('insert_text', { text: '\n- Third note (Alice)' });
    await waitFor(() => content().includes('- Second note\n- Third note (Alice)'), {
      label: 'insert visible to observer',
    });
  });

  test('replace_match rewrites anchored text', async () => {
    const { matches } = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'First note',
    });
    const result = await agent.call<{ replaced: string }>('replace_match', {
      matchId: matches[0]!.matchId,
      text: 'First note, edited by Alice',
    });
    expect(result.replaced).toBe('First note');
    await waitFor(() => content().includes('First note, edited by Alice'), { label: 'replace visible' });
  });

  test('match anchors survive concurrent edits before the match', async () => {
    const { matches } = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'Third note (Alice)',
    });
    observer.text.insert(0, 'HUMAN PREFIX LINE\n');
    await waitFor(() => content().startsWith('HUMAN PREFIX LINE'), { label: 'human prefix synced' });
    await agent.call('replace_match', { matchId: matches[0]!.matchId, text: 'Third note (still anchored)' });
    await waitFor(() => content().includes('- Third note (still anchored)'), { label: 'anchored replace' });
    expect(content()).not.toInclude('Third note (Alice)');
  });

  test('begin_edit/append_text/commit_edit writes progressively at the end', async () => {
    await agent.call('begin_edit', { mode: 'append' });
    await agent.call('append_text', { text: '\n## Alice section\n\nParagraph one.' });
    await waitFor(() => content().includes('Paragraph one.'), { label: 'first chunk visible before commit' });
    await agent.call('append_text', { text: '\nParagraph two.' });
    const committed = await agent.call<{ committedChars: number }>('commit_edit');
    expect(committed.committedChars).toBeGreaterThan(30);
    await waitFor(() => content().includes('Paragraph one.\nParagraph two.'), { label: 'both chunks' });
  });

  test('abort_edit reverts the session even after a human typed elsewhere', async () => {
    const before = content();
    await agent.call('begin_edit', { mode: 'append' });
    await agent.call('append_text', { text: '\nDRAFT THAT WILL BE ABORTED' });
    await waitFor(() => content().includes('DRAFT THAT WILL BE ABORTED'), { label: 'draft visible' });
    observer.text.insert(0, 'CONCURRENT HUMAN EDIT\n');
    await waitFor(() => content().startsWith('CONCURRENT HUMAN EDIT'), { label: 'human edit synced' });
    const { revertedChars } = await agent.call<{ revertedChars: number }>('abort_edit');
    expect(revertedChars).toBeGreaterThan(0);
    await waitFor(() => !content().includes('DRAFT THAT WILL BE ABORTED'), { label: 'draft reverted' });
    expect(content()).toInclude('CONCURRENT HUMAN EDIT');
    expect(content()).toInclude(before.slice(0, 40));
  });

  test('delete_range removes between two anchors', async () => {
    await agent.call('place_cursor', { boundary: 'end' });
    await agent.call('insert_text', { text: '\nSTART_MARK middle text END_MARK\n' });
    const start = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'START_MARK',
    });
    const end = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'END_MARK',
    });
    const { deletedChars, deletedPreview } = await agent.call<{
      deletedChars: number;
      deletedPreview: string;
    }>('delete_range', {
      startMatchId: start.matches[0]!.matchId,
      endMatchId: end.matches[0]!.matchId,
    });
    expect(deletedPreview).toBe('START_MARK middle text END_MARK');
    expect(deletedChars).toBe(deletedPreview.length);
    await waitFor(() => !content().includes('START_MARK'), { label: 'range deleted' });
  });

  test('delete_range echoes only a preview of large deletions', async () => {
    await agent.call('place_cursor', { boundary: 'end' });
    await agent.call('insert_text', { text: `\nBIG_START ${'x'.repeat(500)} BIG_END\n` });
    const start = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'BIG_START',
    });
    const end = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'BIG_END',
    });
    const { deletedChars, deletedPreview } = await agent.call<{
      deletedChars: number;
      deletedPreview: string;
    }>('delete_range', {
      startMatchId: start.matches[0]!.matchId,
      endMatchId: end.matches[0]!.matchId,
    });
    expect(deletedChars).toBeGreaterThan(500);
    expect(deletedPreview.length).toBeLessThan(200);
    expect(deletedPreview).toStartWith('BIG_START');
    expect(deletedPreview).toEndWith('BIG_END');
    await waitFor(() => !content().includes('BIG_START'), { label: 'big range deleted' });
  });

  test('search_text matches literally, including trailing newlines', async () => {
    await agent.call('place_cursor', { boundary: 'end' });
    await agent.call('insert_text', { text: '\nTAIL_LINE\n\n\n' });
    const { matches } = await agent.call<{ matches: Array<{ matchId: string; text: string }> }>(
      'search_text',
      { query: 'TAIL_LINE\n\n\n' },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe('TAIL_LINE\n\n\n');
    // The whole point: trailing whitespace is now anchorable and editable.
    await agent.call('replace_match', { matchId: matches[0]!.matchId, text: 'TAIL_LINE\n' });
    await waitFor(() => content().endsWith('TAIL_LINE\n') && !content().endsWith('TAIL_LINE\n\n'), {
      label: 'trailing newlines collapsed',
    });
  });

  test('replace_text finds and replaces a unique occurrence in one call', async () => {
    await agent.call('place_cursor', { boundary: 'end' });
    await agent.call('insert_text', { text: '\nSWAP_ME alpha\n' });
    const result = await agent.call<{ at: number; deletedChars: number; insertedChars: number }>(
      'replace_text',
      { query: 'SWAP_ME alpha', replacement: 'SWAP_ME beta' },
    );
    expect(result.deletedChars).toBe('SWAP_ME alpha'.length);
    expect(result.insertedChars).toBe('SWAP_ME beta'.length);
    await waitFor(() => content().includes('SWAP_ME beta'), { label: 'one-shot replace visible' });
    expect(content()).not.toInclude('SWAP_ME alpha');
  });

  test('replace_text refuses missing or ambiguous text', async () => {
    const missing = await agent.callExpectingError('replace_text', {
      query: 'NOT_IN_THE_DOCUMENT',
      replacement: 'anything',
    });
    expect(missing).toInclude('not found');

    await agent.call('place_cursor', { boundary: 'end' });
    await agent.call('insert_text', { text: '\nDUP_TOKEN one\nDUP_TOKEN two\n' });
    const ambiguous = await agent.callExpectingError('replace_text', {
      query: 'DUP_TOKEN',
      replacement: 'nope',
    });
    expect(ambiguous).toInclude('occurs 2 times');
    expect(ambiguous).toInclude('replace_match');
  });

  test('comment lifecycle: add, mention, reply, edit, resolve, author-only guards, delete', async () => {
    const bob = await AgentClient.spawn(server.url, 'plosson/bob');
    try {
      await bob.call('open_document', { path: 'demo.md' });
      await agent.call('place_cursor', { boundary: 'end' });
      await agent.call('insert_text', { text: '\nCOMMENT_TARGET zone here\n' });

      // Alice comments on her zone, mentioning bob.
      const { matches } = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
        query: 'COMMENT_TARGET zone',
      });
      const { commentId, quotedText } = await agent.call<{ commentId: string; quotedText: string }>(
        'add_comment',
        { matchId: matches[0]!.matchId, body: 'is this zone right, @plosson/bob?' },
      );
      expect(quotedText).toBe('COMMENT_TARGET zone');

      // Bob sees it when filtering for threads mentioning him, and replies.
      await eventually(
        () => bob.call<{ threads: Array<{ root: { id: string } }> }>('list_comments', {
          mentioning: 'plosson/bob',
        }),
        ({ threads }) => threads.some((thread) => thread.root.id === commentId),
        'comment to sync to bob',
      );
      await bob.call('reply_comment', { commentId, body: 'looks good @plosson/alice' });

      // Author-only: bob cannot edit or delete alice's root.
      expect(await bob.callExpectingError('edit_comment', { commentId, body: 'hijack' })).toInclude(
        'Only the author',
      );
      expect(await bob.callExpectingError('delete_comment', { commentId })).toInclude('Only the author');

      // Alice edits her comment; bob resolves the thread (anyone can).
      await agent.call('edit_comment', { commentId, body: 'zone confirmed' });
      await bob.call('resolve_comment', { commentId });

      const { threads } = await eventually(
        () =>
          agent.call<{
            threads: Array<{
              root: { id: string; body: string };
              replies: Array<{ author: string }>;
              resolved: boolean;
              currentText: string | null;
            }>;
          }>('list_comments', {}),
        (result) => {
          const candidate = result.threads.find((entry) => entry.root.id === commentId);
          return candidate?.resolved === true && candidate.replies.length === 1;
        },
        "bob's reply and resolve to sync to alice",
      );
      const thread = threads.find((candidate) => candidate.root.id === commentId)!;
      expect(thread.root.body).toBe('zone confirmed');
      expect(thread.replies.map((reply) => reply.author)).toEqual(['plosson/bob']);
      expect(thread.resolved).toBe(true);
      expect(thread.currentText).toBe('COMMENT_TARGET zone');

      // Resolved threads are hidden by the filter, and delete cascades.
      const open = await agent.call<{ threads: Array<{ root: { id: string } }> }>('list_comments', {
        includeResolved: false,
      });
      expect(open.threads.map((candidate) => candidate.root.id)).not.toContain(commentId);
      await agent.call('delete_comment', { commentId });
      const after = await agent.call<{ threads: Array<{ root: { id: string } }> }>('list_comments', {});
      expect(after.threads.map((candidate) => candidate.root.id)).not.toContain(commentId);
    } finally {
      await bob.close();
    }
  });

  test('comment anchors survive edits by other peers', async () => {
    await agent.call('place_cursor', { boundary: 'end' });
    await agent.call('insert_text', { text: '\nANCHORED_COMMENT_ZONE\n' });
    const { matches } = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'ANCHORED_COMMENT_ZONE',
    });
    const { commentId } = await agent.call<{ commentId: string }>('add_comment', {
      matchId: matches[0]!.matchId,
      body: 'hold on tight',
    });

    observer.text.insert(0, 'SHIFT EVERYTHING DOWN\n');
    await waitFor(() => content().startsWith('SHIFT EVERYTHING DOWN'), { label: 'shift synced' });

    const { threads } = await agent.call<{
      threads: Array<{ root: { id: string }; currentText: string | null }>;
    }>('list_comments', {});
    const thread = threads.find((candidate) => candidate.root.id === commentId)!;
    expect(thread.currentText).toBe('ANCHORED_COMMENT_ZONE');

    // Deleting the zone orphans the thread but keeps it listed with its quote.
    const zoneStart = content().indexOf('ANCHORED_COMMENT_ZONE');
    observer.text.delete(zoneStart, 'ANCHORED_COMMENT_ZONE'.length);
    await waitFor(() => !content().includes('ANCHORED_COMMENT_ZONE'), { label: 'zone deleted' });

    const orphaned = await eventually(
      () =>
        agent.call<{
          threads: Array<{ root: { id: string }; currentText: string | null; quotedText: string }>;
        }>('list_comments', {}),
      (result) =>
        result.threads.find((candidate) => candidate.root.id === commentId)?.currentText === null,
      'deletion to sync to the agent',
    );
    const orphan = orphaned.threads.find((candidate) => candidate.root.id === commentId)!;
    expect(orphan.currentText).toBeNull();
    expect(orphan.quotedText).toBe('ANCHORED_COMMENT_ZONE');
  });

  test('edits persist to the file on disk', async () => {
    await server.registry.flushAll();
    const onDisk = await Bun.file(join(vaultDir, 'main/demo.md')).text();
    expect(onDisk).toInclude('Third note (still anchored)');
    expect(onDisk).toInclude('Paragraph two.');
    expect(onDisk).not.toInclude('DRAFT THAT WILL BE ABORTED');
  });
});

describe('username convention', () => {
  test('a plain username is a human with no owner', () => {
    expect(parseUsername('plosson')).toEqual({ name: 'plosson', owner: null, role: 'human' });
  });

  test('an owner-scoped username is an agent linked to its owner', () => {
    expect(parseUsername('plosson/claude')).toEqual({
      name: 'plosson/claude',
      owner: 'plosson',
      role: 'agent',
    });
    expect(parseUsername(' plosson/claude\n').name).toBe('plosson/claude');
  });

  test('rejects malformed usernames', () => {
    const rejected = ['', '   ', 'a/b/c', 'plosson/', '/claude', '/', 'a b', 'plosson/cl aude', 'a\tb'];
    for (const bad of rejected) {
      let threw = false;
      try {
        parseUsername(bad);
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(`expected "${bad}" to be rejected`);
      }
    }
  });

  test('resolveIdentity requires MDIO_USERNAME and derives role + color', () => {
    expect(() => resolveIdentity({})).toThrow('MDIO_USERNAME is required');
    const identity = resolveIdentity({ MDIO_USERNAME: 'plosson/claude' });
    expect(identity.role).toBe('agent');
    expect(identity.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(identity.colorLight).toBe(`${identity.color}33`);
    expect(resolveIdentity({ MDIO_USERNAME: 'plosson' }).role).toBe('human');
  });

  test('a lingering pre-rename SHAREMD_USERNAME gets a migration hint', () => {
    expect(() => resolveIdentity({ SHAREMD_USERNAME: 'plosson/claude' })).toThrow(
      /SHAREMD_\* env vars were replaced by MDIO_\*/,
    );
    expect(() => resolveIdentity({ SHAREMD_AGENT_NAME: 'Claude' })).toThrow(
      /SHAREMD_\* env vars were replaced by MDIO_\*/,
    );
  });

  test('MDIO_AGENT_COLOR overrides the derived color', () => {
    const identity = resolveIdentity({ MDIO_USERNAME: 'plosson/claude', MDIO_AGENT_COLOR: '#123456' });
    expect(identity.color).toBe('#123456');
  });
});
