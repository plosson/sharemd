/**
 * The inbox: unhandled @mentions and documents with pending suggested edits,
 * aggregated across every project (GET /api/mentions). It is not its own URL —
 * it lives inside Home. A mention row deep-links to its document with the thread
 * focused (the existing `comment=` hash); a suggestion row opens the document so
 * the human can review the proposal. Handled threads drop out unless the
 * "show handled" toggle is on (mirrors the server's `open=false`).
 */

import * as api from './api';
import type { SurfaceContext } from './surface';
import { avatar, el, relativeTime } from './ui';

/** One-line excerpt of a comment body for the row. */
function excerpt(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function mentionRow(mention: api.InboxMention, ctx: SurfaceContext): HTMLElement {
  const fullPath = `${mention.project}/${mention.doc}`;
  const meta = el(
    'div',
    { class: 'inbox-meta' },
    el('span', { class: 'inbox-author', text: mention.request.author }),
    el('span', { class: 'inbox-where', text: `${mention.project} / ${mention.doc}` }),
    el('span', { class: 'inbox-time', text: relativeTime(mention.request.createdAt) }),
    mention.resolved ? el('span', { class: 'inbox-tag', text: 'resolved' }) : null,
    mention.respondedByWho ? el('span', { class: 'inbox-tag', text: 'replied' }) : null,
  );
  const body = el('div', { class: 'inbox-body', text: excerpt(mention.request.body) });
  const quote =
    mention.currentText !== null
      ? el('div', { class: 'inbox-quote', text: mention.currentText })
      : el('div', { class: 'inbox-quote orphan', text: 'original text deleted' });
  return el(
    'button',
    {
      class: 'inbox-row',
      type: 'button',
      onClick: () => {
        ctx.go({ kind: 'doc', project: mention.project, doc: fullPath }, { doc: { comment: mention.threadId } });
      },
    },
    avatar({ name: mention.request.author, role: mention.request.author.includes('/') ? 'agent' : 'human' }),
    el('div', { class: 'inbox-main' }, meta, body, quote),
  );
}

function suggestionRow(entry: api.InboxSuggestions, ctx: SurfaceContext): HTMLElement {
  const fullPath = `${entry.project}/${entry.doc}`;
  const label = entry.pending === 1 ? '1 suggested edit' : `${entry.pending} suggested edits`;
  return el(
    'button',
    {
      class: 'inbox-row',
      type: 'button',
      onClick: () => ctx.go({ kind: 'doc', project: entry.project, doc: fullPath }),
    },
    el('span', { class: 'inbox-suggest-badge', text: '✎' }),
    el(
      'div',
      { class: 'inbox-main' },
      el(
        'div',
        { class: 'inbox-meta' },
        el('span', { class: 'inbox-author', text: `${label} awaiting review` }),
        el('span', { class: 'inbox-where', text: `${entry.project} / ${entry.doc}` }),
      ),
    ),
  );
}

interface InboxOptions {
  /** Cap the number of mention rows; a "view all" link lifts it. */
  cap?: number;
  /** Called with the total unhandled count once loaded (Home's heading counter). */
  onCount?: (count: number) => void;
}

/**
 * Render the inbox into `host`. Owns its own fetch, the show-handled toggle, and
 * (optionally) a capped view with a "view all" affordance.
 */
export function renderInbox(host: HTMLElement, ctx: SurfaceContext, options: InboxOptions = {}): void {
  let showHandled = false;
  let expanded = false;

  const list = el('div', { class: 'inbox-list' });
  const toggle = el('label', { class: 'inbox-filter' });
  const checkbox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  toggle.append(checkbox, ' show handled');
  checkbox.addEventListener('change', () => {
    showHandled = checkbox.checked;
    void load();
  });

  const header = el(
    'div',
    { class: 'inbox-header' },
    el('h2', { text: 'Needs your attention' }),
    toggle,
  );
  host.append(header, list);

  async function load(): Promise<void> {
    list.replaceChildren(el('p', { class: 'inbox-empty', text: 'Loading…' }));
    let inbox: api.Inbox;
    try {
      inbox = await api.getInbox(ctx.me.name, { includeHandled: showHandled });
    } catch {
      list.replaceChildren(el('p', { class: 'inbox-empty', text: 'Could not load your inbox.' }));
      return;
    }
    options.onCount?.(inbox.mentions.filter((m) => !m.resolved && !m.respondedByWho).length);

    if (inbox.mentions.length === 0 && inbox.suggestions.length === 0) {
      list.replaceChildren(
        showHandled
          ? el('p', { class: 'inbox-empty', text: 'Nothing here.' })
          : el(
              'p',
              { class: 'inbox-empty' },
              el('span', { class: 'inbox-empty-lead', text: 'Nothing needs you.' }),
              ' Mention ',
              el('span', { class: 'comment-mention', text: '@agent' }),
              ' in a comment to hand off work.',
            ),
      );
      return;
    }

    const rows: HTMLElement[] = [];
    const cap = options.cap && !expanded ? options.cap : Infinity;
    for (const mention of inbox.mentions.slice(0, cap)) {
      rows.push(mentionRow(mention, ctx));
    }
    for (const suggestion of inbox.suggestions) {
      rows.push(suggestionRow(suggestion, ctx));
    }
    if (options.cap && !expanded && inbox.mentions.length > options.cap) {
      rows.push(
        el('button', {
          class: 'inbox-viewall',
          type: 'button',
          text: `View all ${inbox.mentions.length} mentions`,
          onClick: () => {
            expanded = true;
            void load();
          },
        }),
      );
    }
    list.replaceChildren(...rows);
  }

  void load();
}
