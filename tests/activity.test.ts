import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startTestServer } from './helpers';
import type { MdioServer } from '../src/server/index';
import { AgentClient } from './mcp-client';

/**
 * The per-project activity feed (GET /api/projects/:p/activity) surfaces the
 * events already flowing through a room — join/leave, writing, suggestions,
 * comments, and version saves. The buffer is ephemeral (in-memory), so these
 * assertions poll it right after driving an agent, tolerant of sync timing.
 */

let server: MdioServer;
let agent: AgentClient;

const AGENT = 'plosson/scribe';

beforeAll(async () => {
  ({ server } = await startTestServer());
  agent = await AgentClient.spawn(server.url, AGENT);
});

afterAll(async () => {
  await agent.close();
  await server.stop();
});

interface ActivityEvent {
  ts: number;
  actor: string;
  role: string;
  kind: string;
  doc: string;
  detail?: string;
}

async function activity(project = 'main'): Promise<ActivityEvent[]> {
  const response = await fetch(`${server.url}/api/projects/${project}/activity`);
  if (!response.ok) {
    throw new Error(`activity ${response.status}`);
  }
  return ((await response.json()) as { events: ActivityEvent[] }).events;
}

/** Poll until every wanted kind is present for the agent; returns the agent's events in order. */
async function waitForKinds(want: string[]): Promise<ActivityEvent[]> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const mine = (await activity()).filter((event) => event.actor === AGENT);
    const kinds = new Set(mine.map((event) => event.kind));
    if (want.every((kind) => kinds.has(kind))) {
      return mine;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for activity kinds ${want.join(', ')}`);
}

test('feed streams join, writing, suggestion, comment, and resolve events in order', async () => {
  await agent.call('open_document', { path: 'demo.md' }); // joined
  await agent.call('begin_edit', { mode: 'append' }); // writing (composing)
  await agent.call('append_text', { text: '\nACTIVITY_ANCHOR line\n' });
  await agent.call('commit_edit'); // finished

  const found = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
    query: 'ACTIVITY_ANCHOR line',
  });
  await agent.call('suggest_replace', { matchId: found.matches[0]!.matchId, text: 'ACTIVITY_REPLACED' }); // suggested

  const commentTarget = await agent.call<{ matches: Array<{ matchId: string }> }>('search_text', {
    query: 'ACTIVITY_ANCHOR line',
  });
  const { commentId } = await agent.call<{ commentId: string }>('add_comment', {
    matchId: commentTarget.matches[0]!.matchId,
    body: 'is this anchor right?',
  }); // commented
  await agent.call('resolve_comment', { commentId }); // resolved

  const mine = await waitForKinds(['joined', 'writing', 'suggested', 'commented', 'resolved']);

  // Every event is attributed to the agent, in the project-relative document.
  for (const event of mine) {
    expect(event.role).toBe('agent');
    expect(event.doc).toBe('demo.md');
  }

  // Chronological order: join → writing → suggested → commented → resolved.
  const first = (kind: string) => mine.findIndex((event) => event.kind === kind);
  expect(first('joined')).toBeLessThan(first('writing'));
  expect(first('writing')).toBeLessThan(first('suggested'));
  expect(first('suggested')).toBeLessThan(first('commented'));
  expect(first('commented')).toBeLessThan(first('resolved'));
});

test('saving a named version records a version event', async () => {
  const response = await fetch(`${server.url}/api/projects/main/docs/demo.md/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'activity checkpoint', author: 'plosson' }),
  });
  expect(response.ok).toBe(true);

  for (let attempt = 0; attempt < 40; attempt++) {
    const saved = (await activity()).find((event) => event.kind === 'saved');
    if (saved) {
      expect(saved.actor).toBe('plosson');
      expect(saved.role).toBe('human');
      expect(saved.detail).toBe('activity checkpoint');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for a saved-version event');
});

test('a leaving agent records a left event', async () => {
  const visitor = await AgentClient.spawn(server.url, 'plosson/visitor');
  await visitor.call('open_document', { path: 'demo.md' });
  // Wait for the join to register before leaving, so ordering is deterministic.
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await activity()).some((event) => event.actor === 'plosson/visitor' && event.kind === 'joined')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await visitor.close();

  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await activity()).some((event) => event.actor === 'plosson/visitor' && event.kind === 'left')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for a left event');
});

test('an unknown project returns 404', async () => {
  const response = await fetch(`${server.url}/api/projects/does-not-exist/activity`);
  expect(response.status).toBe(404);
});
