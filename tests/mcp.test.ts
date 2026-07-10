import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { connectPeer, startTestServer, waitFor, type TestPeer } from './helpers';
import type { ShareMdServer } from '../src/server/index';
import { AgentClient } from './mcp-client';

let server: ShareMdServer;
let vaultDir: string;
let agent: AgentClient;
let observer: TestPeer;

beforeAll(async () => {
  ({ server, vaultDir } = await startTestServer());
  agent = await AgentClient.spawn(server.url, 'Alice');
  observer = await connectPeer(server, 'demo.md');
});

afterAll(async () => {
  await agent.close();
  observer.destroy();
  await server.stop();
});

const content = () => observer.text.toString();

describe('sharemd MCP', () => {
  test('exposes the agreed tool surface', async () => {
    expect(await agent.listTools()).toEqual([
      'abort_edit',
      'append_text',
      'begin_edit',
      'commit_edit',
      'delete_range',
      'insert_text',
      'list_documents',
      'open_document',
      'place_cursor',
      'read_document',
      'replace_match',
      'search_text',
    ]);
  });

  test('list_documents returns the vault', async () => {
    const { docs } = await agent.call<{ docs: string[] }>('list_documents');
    expect(docs).toEqual(['demo.md', 'other.md']);
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

  test('agent presence appears in the room with role=agent', async () => {
    await waitFor(
      () =>
        [...observer.provider.awareness.getStates().values()].some(
          (state) =>
            (state as { user?: { name?: string; role?: string } }).user?.name === 'Alice' &&
            (state as { user?: { role?: string } }).user?.role === 'agent',
        ),
      { label: 'agent presence' },
    );
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
    const { deletedText } = await agent.call<{ deletedText: string }>('delete_range', {
      startMatchId: start.matches[0]!.matchId,
      endMatchId: end.matches[0]!.matchId,
    });
    expect(deletedText).toBe('START_MARK middle text END_MARK');
    await waitFor(() => !content().includes('START_MARK'), { label: 'range deleted' });
  });

  test('edits persist to the file on disk', async () => {
    await server.registry.flushAll();
    const onDisk = await Bun.file(join(vaultDir, 'demo.md')).text();
    expect(onDisk).toInclude('Third note (still anchored)');
    expect(onDisk).toInclude('Paragraph two.');
    expect(onDisk).not.toInclude('DRAFT THAT WILL BE ABORTED');
  });
});
