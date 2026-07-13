import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';

/**
 * Transient highlights for remote edits: when another collaborator inserts
 * text, the inserted range flashes in their color with a small name badge,
 * then fades away. Attribution comes from the Yjs items themselves — every
 * inserted item carries the author's client id, which maps to their awareness
 * user state (name + color).
 */

const HIGHLIGHT_MS = 2000;
/** Ranges from the same author merging distance (chars). */
const MERGE_SLACK = 2;

interface HighlightEntry {
  id: number;
  client: number;
  name: string;
  color: string;
  colorLight: string;
  from: number;
  to: number;
  /** Bumped on every extension so decorations rebuild and the fade restarts. */
  generation: number;
}

const addHighlight = StateEffect.define<HighlightEntry>();
const extendHighlight = StateEffect.define<{ id: number; from: number; to: number }>();
const removeHighlight = StateEffect.define<{ id: number }>();

class BadgeWidget extends WidgetType {
  constructor(
    readonly entryId: number,
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }

  override eq(other: BadgeWidget): boolean {
    return other.entryId === this.entryId && other.name === this.name;
  }

  override toDOM(): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'sharemd-edit-badge';
    badge.style.background = this.color;
    badge.textContent = `✏ ${this.name}`;
    return badge;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const highlightField = StateField.define<HighlightEntry[]>({
  create: () => [],
  update(entries, tr) {
    let next = entries;
    if (tr.docChanged) {
      next = next
        .map((entry) => ({
          ...entry,
          // from sticks right / to sticks left so adjacent inserts by OTHER
          // authors stay outside; same-author inserts merge via extendHighlight.
          from: tr.changes.mapPos(entry.from, 1),
          to: tr.changes.mapPos(entry.to, -1),
        }))
        .filter((entry) => entry.to > entry.from);
    }
    for (const effect of tr.effects) {
      if (effect.is(addHighlight)) {
        next = [...next, effect.value];
      } else if (effect.is(extendHighlight)) {
        next = next.map((entry) =>
          entry.id === effect.value.id
            ? {
                ...entry,
                from: Math.min(entry.from, effect.value.from),
                to: Math.max(entry.to, effect.value.to),
                generation: entry.generation + 1,
              }
            : entry,
        );
      } else if (effect.is(removeHighlight)) {
        next = next.filter((entry) => entry.id !== effect.value.id);
      }
    }
    return next;
  },
});

function buildDecorations(entries: HighlightEntry[], docLength: number): DecorationSet {
  if (entries.length === 0) {
    return Decoration.none;
  }
  const ranges = [];
  for (const entry of entries) {
    const from = Math.min(entry.from, docLength);
    const to = Math.min(entry.to, docLength);
    if (to <= from) {
      continue;
    }
    ranges.push(
      Decoration.widget({ widget: new BadgeWidget(entry.id, entry.name, entry.color), side: -1 }).range(from),
      Decoration.mark({
        class: 'sharemd-remote-edit',
        attributes: {
          style: `--sharemd-edit-bg:${entry.colorLight};--sharemd-edit-gen:${entry.generation}`,
        },
      }).range(from, to),
    );
  }
  return Decoration.set(ranges, true);
}

export function remoteEditExtension() {
  return [
    highlightField,
    EditorView.decorations.compute(['doc', highlightField], (state) =>
      buildDecorations(state.field(highlightField), state.doc.length),
    ),
  ];
}

interface AuthorRange {
  client: number;
  from: number;
  to: number;
}

/**
 * One walk over the text items: absolute ranges of the items created in this
 * transaction by other clients. An item is "new" when its clock falls in the
 * transaction's beforeState→afterState window for its author.
 */
function addedRangesByAuthor(
  ytext: Y.Text,
  transaction: Y.Transaction,
  ownClient: number,
): AuthorRange[] {
  const ranges: AuthorRange[] = [];
  let index = 0;
  // Yjs internals: items form a linked list; countable, non-deleted items
  // contribute to the text index. Item ids carry the author's client id.
  type Item = {
    right: Item | null;
    countable: boolean;
    deleted: boolean;
    length: number;
    id: { client: number; clock: number };
  };
  for (
    let item = (ytext as unknown as { _start: Item | null })._start;
    item !== null;
    item = item.right
  ) {
    if (!item.countable || item.deleted) {
      continue;
    }
    const client = item.id.client;
    if (client !== ownClient) {
      const beforeClock = transaction.beforeState.get(client) ?? 0;
      const afterClock = transaction.afterState.get(client) ?? 0;
      if (item.id.clock >= beforeClock && item.id.clock < afterClock) {
        const last = ranges[ranges.length - 1];
        if (last && last.client === client && index <= last.to + MERGE_SLACK) {
          last.to = index + item.length;
        } else {
          ranges.push({ client, from: index, to: index + item.length });
        }
      }
    }
    index += item.length;
  }
  return ranges;
}

export interface EditAuthor {
  name?: string;
  color?: string;
  colorLight?: string;
}

/**
 * Flash author-attributed highlights for edits applied to `ytext` by clients
 * other than `ownClient`. Attaches immediately; identity comes from the given
 * resolver, so live views resolve via awareness and replays via the doc's
 * authors map.
 */
export function wireEditHighlights(
  view: EditorView,
  ytext: Y.Text,
  ownClient: number,
  resolveAuthor: (client: number) => EditAuthor | undefined,
): () => void {
  let seq = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const schedule = (id: number) => {
    const existing = timers.get(id);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        view.dispatch({ effects: removeHighlight.of({ id }) });
      }, HIGHLIGHT_MS),
    );
  };

  const observer = (event: Y.YTextEvent) => {
    if (event.transaction.local) {
      return;
    }
    const ranges = addedRangesByAuthor(ytext, event.transaction, ownClient);
    if (ranges.length === 0) {
      return;
    }
    const entries = view.state.field(highlightField);
    const effects = [];
    for (const range of ranges) {
      const author = resolveAuthor(range.client);
      const name = author?.name ?? 'someone';
      const color = author?.color ?? '#7a7a7a';
      const colorLight = author?.colorLight ?? `${color}33`;
      const existing = entries.find(
        (entry) =>
          entry.client === range.client &&
          range.from <= entry.to + MERGE_SLACK &&
          range.to >= entry.from - MERGE_SLACK,
      );
      if (existing) {
        effects.push(extendHighlight.of({ id: existing.id, from: range.from, to: range.to }));
        schedule(existing.id);
      } else {
        const id = ++seq;
        effects.push(
          addHighlight.of({
            id,
            client: range.client,
            name,
            color,
            colorLight,
            from: range.from,
            to: range.to,
            generation: 0,
          }),
        );
        schedule(id);
      }
    }
    if (effects.length > 0) {
      view.dispatch({ effects });
    }
  };

  ytext.observe(observer);

  return () => {
    ytext.unobserve(observer);
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };
}

export function wireRemoteEdits(
  view: EditorView,
  ytext: Y.Text,
  provider: WebsocketProvider,
  ownClient: number,
): () => void {
  const resolveAuthor = (client: number) =>
    (provider.awareness.getStates().get(client) as { user?: EditAuthor } | undefined)?.user;

  // Attach only once the initial sync is done, so hydrating the document
  // content doesn't flash as one giant "edit".
  let detach: (() => void) | null = null;
  const attach = () => {
    detach ??= wireEditHighlights(view, ytext, ownClient, resolveAuthor);
  };
  if (provider.synced) {
    attach();
  } else {
    const onSync = (synced: boolean) => {
      if (synced) {
        provider.off('sync', onSync);
        attach();
      }
    };
    provider.on('sync', onSync);
  }

  return () => {
    detach?.();
  };
}
