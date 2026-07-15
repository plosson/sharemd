/**
 * Home (`/`): the landing surface. A greeting with live counts, a grid of
 * project cards (doc count, last edit, present peers) plus ghost cards for
 * creating a project or connecting an agent, the inbox block (shared with the
 * sidebar Inbox item), and recents across projects. With no projects yet it
 * shows a first-run welcome instead. Nothing here auto-opens a document.
 */

import * as api from './api';
import { askChoice } from './dialogs';
import { renderInbox } from './inbox';
import type { SurfaceContext } from './surface';
import { activityLabel, avatar, el, relativeTime } from './ui';

interface ProjectSummary {
  name: string;
  docs: api.DocMeta[];
  peers: api.ProjectPeer[];
  activity: api.ActivityEvent[];
}

function greeting(name: string): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}`;
}

function activityStrip(events: api.ActivityEvent[]): HTMLElement | null {
  if (events.length === 0) {
    return null;
  }
  // The last 3, newest first — a glanceable "what happened here lately".
  const recent = events.slice(-3).reverse();
  return el(
    'div',
    { class: 'card-activity' },
    ...recent.map((event) =>
      el(
        'div',
        { class: 'card-activity-row' },
        el('span', { class: 'card-activity-actor', text: event.actor.split('/').pop() ?? event.actor }),
        el('span', { class: 'card-activity-text', text: ` ${activityLabel(event.kind, event.detail)}` }),
      ),
    ),
  );
}

function projectCard(summary: ProjectSummary, ctx: SurfaceContext): HTMLElement {
  const lastEdit = summary.docs.reduce((max, doc) => Math.max(max, doc.modified), 0);
  const faces = el('div', { class: 'card-presence' });
  for (const peer of summary.peers.slice(0, 5)) {
    faces.append(avatar(peer));
  }
  return el(
    'button',
    { class: 'project-card', type: 'button', onClick: () => ctx.go({ kind: 'project', project: summary.name }) },
    el('div', { class: 'card-title', text: summary.name }),
    el(
      'div',
      { class: 'card-sub' },
      `${summary.docs.length} ${summary.docs.length === 1 ? 'document' : 'documents'}`,
      lastEdit ? el('span', { class: 'card-dot', text: '·' }) : null,
      lastEdit ? `edited ${relativeTime(lastEdit)}` : null,
    ),
    activityStrip(summary.activity),
    faces,
  );
}

function ghostCard(label: string, onClick: () => void): HTMLElement {
  return el('button', { class: 'project-card ghost', type: 'button', text: label, onClick });
}

function recentsSection(summaries: ProjectSummary[], ctx: SurfaceContext): HTMLElement | null {
  const recents = summaries
    .flatMap((summary) => summary.docs.map((doc) => ({ ...doc, project: summary.name })))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 8);
  if (recents.length === 0) {
    return null;
  }
  const list = el('div', { class: 'recents-list' });
  for (const doc of recents) {
    list.append(
      el(
        'button',
        {
          class: 'recent-row',
          type: 'button',
          onClick: () => ctx.go({ kind: 'doc', project: doc.project, doc: `${doc.project}/${doc.path}` }),
        },
        el('span', { class: 'recent-title', text: doc.title ?? doc.path.slice(doc.path.lastIndexOf('/') + 1) }),
        el('span', { class: 'recent-where', text: doc.project }),
        el('span', { class: 'recent-time', text: relativeTime(doc.modified) }),
      ),
    );
  }
  return el('section', { class: 'home-section' }, el('h2', { text: 'Recent documents' }), list);
}

/** First-run welcome shown when there are no projects yet. */
function firstRun(ctx: SurfaceContext): HTMLElement {
  return el(
    'div',
    { class: 'first-run' },
    el('div', { class: 'first-run-brand', text: 'mdio' }),
    el('p', { class: 'first-run-tagline', text: 'Live markdown for humans and AI agents.' }),
    el(
      'div',
      { class: 'first-run-actions' },
      el('button', { class: 'empty-btn primary', type: 'button', text: '＋ Create your first project', onClick: () => void ctx.newProject() }),
    ),
  );
}

/** Route "Connect an agent" to a project's Agents page, asking which when several. */
async function connectAnAgent(ctx: SurfaceContext): Promise<void> {
  if (ctx.projects.length === 1) {
    ctx.go({ kind: 'agents', project: ctx.projects[0]! });
    return;
  }
  const project = await askChoice({
    title: 'Connect an agent to…',
    hint: 'Pick the project the agent should join.',
    options: ctx.projects.map((name) => ({ value: name, label: name })),
  });
  if (project) {
    ctx.go({ kind: 'agents', project });
  }
}

export function renderHome(host: HTMLElement, ctx: SurfaceContext): void {
  const page = el('div', { class: 'home' });
  host.append(page);

  if (ctx.projects.length === 0) {
    page.append(firstRun(ctx));
    return;
  }

  const heading = el('div', { class: 'home-heading' });
  const title = el('h1', { text: greeting(ctx.me.name) });
  const counts = el('p', { class: 'home-counts', text: `${ctx.projects.length} projects` });
  heading.append(title, counts);
  const grid = el('div', { class: 'project-grid' });
  const inboxSection = el('section', { class: 'home-section inbox' });
  const recentsHost = el('div');
  page.append(heading, grid, inboxSection, recentsHost);

  renderInbox(inboxSection, ctx, { cap: 5 });

  void (async () => {
    const summaries: ProjectSummary[] = await Promise.all(
      ctx.projects.map(async (name) => {
        const [docs, peers, activity] = await Promise.all([
          api.listDocs(name).catch(() => [] as api.DocMeta[]),
          api.getPeers(name).catch(() => [] as api.ProjectPeer[]),
          api.getActivity(name).catch(() => [] as api.ActivityEvent[]),
        ]);
        return { name, docs, peers, activity };
      }),
    );
    const docCount = summaries.reduce((sum, s) => sum + s.docs.length, 0);
    const agentCount = summaries.reduce((sum, s) => sum + s.peers.filter((p) => p.role === 'agent').length, 0);
    counts.textContent =
      `${ctx.projects.length} ${ctx.projects.length === 1 ? 'project' : 'projects'} · ` +
      `${docCount} ${docCount === 1 ? 'document' : 'documents'}` +
      (agentCount > 0 ? ` · ${agentCount} ${agentCount === 1 ? 'agent' : 'agents'} connected` : '');

    grid.replaceChildren(
      ...summaries.map((summary) => projectCard(summary, ctx)),
      ghostCard('＋ New project', () => void ctx.newProject()),
      ghostCard('🤖 Connect an agent', () => void connectAnAgent(ctx)),
    );

    const recents = recentsSection(summaries, ctx);
    if (recents) {
      recentsHost.replaceChildren(recents);
    }
  })();
}
