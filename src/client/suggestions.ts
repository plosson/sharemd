import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type * as Y from 'yjs';
import {
  acceptSuggestion,
  deleteSuggestion,
  listSuggestions,
  rejectSuggestion,
  SUGGESTIONS_KEY,
  type SuggestionView,
} from '../shared/suggestions';
import { AUTHORS_KEY, TEXT_KEY, type AuthorInfo } from '../shared/blame';
import { askConfirm, toast } from './dialogs';

/**
 * Suggesting-mode UI: an agent's proposed edits render inline (ghost text for
 * inserts, struck-through / highlighted ranges for deletes and replaces) and in
 * a panel where a human accepts or rejects each one. All state is the shared
 * `suggestions` map in the Y.Doc, so it syncs and persists like comments.
 */

// ── editor decorations ─────────────────────────────────────────────────────

interface SuggestRange {
  id: string;
  kind: SuggestionView['kind'];
  from: number;
  to: number;
  text: string;
  focused: boolean;
}

class GhostWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly text: string,
  ) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text && other.id === this.id;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mdio-suggest-ghost';
    span.textContent = this.text;
    // Carry the id so a click on the ghost insert resolves to its suggestion,
    // just like a click on a delete/replace mark does.
    span.dataset.suggestionId = this.id;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const setSuggestRanges = StateEffect.define<SuggestRange[]>();

const suggestField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setSuggestRanges)) {
        const marks = effect.value.map((range) => {
          const attrs = { 'data-suggestion-id': range.id };
          if (range.kind === 'insert') {
            return Decoration.widget({ widget: new GhostWidget(range.id, range.text), side: 1 }).range(range.from);
          }
          const cls = range.kind === 'delete' ? 'mdio-suggest-delete' : 'mdio-suggest-replace';
          return Decoration.mark({
            class: range.focused ? `${cls} mdio-suggest-focused` : cls,
            attributes: attrs,
          }).range(range.from, range.to);
        });
        next = Decoration.set(marks, true);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function suggestionHighlightExtension() {
  return [suggestField];
}

// ── panel ──────────────────────────────────────────────────────────────────

const panel = document.querySelector('#suggestions-panel')! as HTMLElement;
const listEl = document.querySelector('#suggestions-list')!;
const titleEl = document.querySelector('#suggestions-title')! as HTMLElement;
const acceptAllButton = document.querySelector('#suggest-accept-all')! as HTMLButtonElement;
const rejectAllButton = document.querySelector('#suggest-reject-all')! as HTMLButtonElement;

interface Wiring {
  view: EditorView;
  doc: Y.Doc;
  user: { name: string };
  focusedId: string | null;
}

let wiring: Wiring | null = null;

function authorColor(doc: Y.Doc, name: string): string {
  for (const info of doc.getMap<AuthorInfo>(AUTHORS_KEY).values()) {
    if (info.name === name && info.color) {
      return info.color;
    }
  }
  return '#7a7a7a';
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `suggest-btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function previewLine(cls: string, text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  return span;
}

// ── inline popover (click a mark → anchored accept/reject) ───────────────────
//
// Known v1 limitation (documented in the PR #9 review): accept applies the edit
// in the accepting peer's own doc and marks the suggestion accepted with LWW, so
// two browsers accepting the same suggestion concurrently can each apply it
// before seeing the other's status flip — double-applying the text. Single-human
// review makes this rare; a proper fix needs a claim/lock we deliberately deferred.

let popover: HTMLElement | null = null;
let popoverId: string | null = null;
let popoverCleanup: (() => void) | null = null;

function closePopover(): void {
  popoverCleanup?.();
  popoverCleanup = null;
  popover?.remove();
  popover = null;
  popoverId = null;
}

/** Anchored popover at a suggestion mark: author, kind, −old/+new, Accept/Reject/Withdraw. */
function openPopover(id: string): void {
  const w = wiring;
  if (!w) {
    return;
  }
  const suggestion = listSuggestions(w.doc).find((s) => s.id === id);
  // Only a pending, still-anchored suggestion has a mark to point at.
  if (!suggestion || suggestion.status !== 'pending' || suggestion.range === null) {
    closePopover();
    return;
  }
  closePopover();
  popoverId = id;

  const el = document.createElement('div');
  el.className = 'suggest-popover';
  el.dataset.suggestionId = id;

  const head = document.createElement('div');
  head.className = 'suggest-head';
  const chip = document.createElement('span');
  chip.className = 'peer';
  chip.style.background = authorColor(w.doc, suggestion.author);
  chip.textContent = suggestion.author;
  const kind = document.createElement('span');
  kind.className = 'suggest-kind';
  kind.textContent = suggestion.kind;
  head.append(chip, kind);
  el.appendChild(head);

  const preview = document.createElement('div');
  preview.className = 'suggest-preview';
  if (suggestion.kind === 'insert') {
    preview.appendChild(previewLine('suggest-add', `+ ${shorten(suggestion.text)}`));
  } else {
    preview.appendChild(previewLine('suggest-del', `− ${shorten(suggestion.quotedText)}`));
    if (suggestion.kind === 'replace') {
      preview.appendChild(previewLine('suggest-add', `+ ${shorten(suggestion.text)}`));
    }
  }
  el.appendChild(preview);

  const actions = document.createElement('div');
  actions.className = 'suggest-actions';
  actions.appendChild(
    button('✓ Accept', 'primary', () => {
      try {
        acceptSuggestion(w.doc, id, w.user.name);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'error' });
      }
      closePopover();
    }),
  );
  actions.appendChild(
    button('✕ Reject', '', () => {
      rejectSuggestion(w.doc, id, w.user.name);
      closePopover();
    }),
  );
  if (suggestion.author === w.user.name) {
    actions.appendChild(
      button('Withdraw', 'subtle', () => {
        deleteSuggestion(w.doc, id);
        closePopover();
      }),
    );
  }
  el.appendChild(actions);

  document.body.appendChild(el);
  popover = el;
  placePopover(suggestion.range.from);

  // Close on outside click, Escape, and editor scroll (repositioning is overkill).
  const onDocDown = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (!el.contains(target) && !target.closest('[data-suggestion-id]')) {
      closePopover();
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      closePopover();
    }
  };
  // Follow the anchor on scroll/resize (including the scroll-into-view we trigger
  // on open); close only once it scrolls fully out of the editor viewport.
  const onScroll = () => {
    const w2 = wiring;
    if (!w2 || !popoverId) {
      return;
    }
    const still = listSuggestions(w2.doc).find((s) => s.id === popoverId);
    if (still && still.range) {
      repositionPopover(still.range.from);
    } else {
      closePopover();
    }
  };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  w.view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  popoverCleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    w.view.scrollDOM.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

/** Place the popover just below `coords`, nudged in to stay on-screen. */
function placeAt(coords: { left: number; top: number; bottom: number }): void {
  if (!popover) {
    return;
  }
  popover.style.left = `${coords.left}px`;
  popover.style.top = `${coords.bottom + 6}px`;
  const rect = popover.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) {
    popover.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
  }
  if (rect.bottom > window.innerHeight - 8) {
    popover.style.top = `${Math.max(8, coords.top - rect.height - 6)}px`;
  }
}

/**
 * Open-time placement: scroll the anchor into the editor's viewport, then place
 * once CodeMirror has measured it. In a long document the anchored line may not
 * be rendered yet, so `coordsAtPos` can be null until the scroll settles.
 */
function placePopover(pos: number): void {
  const w = wiring;
  if (!w) {
    return;
  }
  w.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'nearest' }) });
  const now = w.view.coordsAtPos(pos);
  if (now) {
    placeAt(now);
  }
  w.view.requestMeasure({
    read: () => w.view.coordsAtPos(pos),
    write: (coords) => {
      if (coords && popover) {
        placeAt(coords);
      }
    },
  });
}

/** Reposition an open popover from current coords (on text shift); close if scrolled away. */
function repositionPopover(pos: number): void {
  if (!popover || !wiring) {
    return;
  }
  const coords = wiring.view.coordsAtPos(pos);
  if (!coords) {
    closePopover();
    return;
  }
  placeAt(coords);
}

// ── bulk review (right rail) ─────────────────────────────────────────────────

async function acceptAll(): Promise<void> {
  const w = wiring;
  if (!w) {
    return;
  }
  const total = listSuggestions(w.doc).filter((s) => s.status === 'pending').length;
  if (total === 0) {
    return;
  }
  const ok = await askConfirm({
    title: `Accept all ${total} suggestions?`,
    body: 'Applies every pending suggested edit to the document, in anchor order. Orphaned ones (their target text was deleted) are skipped.',
    confirmLabel: 'Accept all',
    danger: true,
  });
  if (!ok || !wiring) {
    return;
  }
  closePopover();
  let applied = 0;
  let skipped = 0;
  // Re-resolve ranges after each application: accepting shifts the text, so we
  // re-list every pass and take the topmost still-anchored one. `attempted`
  // stops a throwing accept from looping forever.
  const attempted = new Set<string>();
  for (;;) {
    const pending = listSuggestions(w.doc).filter((s) => s.status === 'pending' && !attempted.has(s.id));
    if (pending.length === 0) {
      break;
    }
    const next = pending.find((s) => s.range !== null);
    if (!next) {
      skipped += pending.length; // only orphans remain
      break;
    }
    attempted.add(next.id);
    try {
      acceptSuggestion(w.doc, next.id, w.user.name);
      applied += 1;
    } catch {
      skipped += 1; // orphaned between passes
    }
  }
  toast(`Accepted ${applied}${skipped ? `, skipped ${skipped} orphaned` : ''}`);
}

async function rejectAll(): Promise<void> {
  const w = wiring;
  if (!w) {
    return;
  }
  const pending = listSuggestions(w.doc).filter((s) => s.status === 'pending');
  if (pending.length === 0) {
    return;
  }
  const ok = await askConfirm({
    title: `Reject all ${pending.length} suggestions?`,
    body: 'Dismisses every pending suggested edit. The document text is left unchanged.',
    confirmLabel: 'Reject all',
    danger: true,
  });
  if (!ok || !wiring) {
    return;
  }
  closePopover();
  let rejected = 0;
  for (const suggestion of pending) {
    try {
      rejectSuggestion(w.doc, suggestion.id, w.user.name);
      rejected += 1;
    } catch {
      // already resolved by a concurrent peer; skip
    }
  }
  toast(`Rejected ${rejected}`);
}

function card(suggestion: SuggestionView): HTMLElement {
  const w = wiring!;
  const el = document.createElement('div');
  el.className = 'suggest-card';
  if (suggestion.id === w.focusedId) {
    el.classList.add('focused');
  }
  el.dataset.suggestionId = suggestion.id;

  const head = document.createElement('div');
  head.className = 'suggest-head';
  const chip = document.createElement('span');
  chip.className = 'peer';
  chip.style.background = authorColor(w.doc, suggestion.author);
  chip.textContent = suggestion.author;
  const kind = document.createElement('span');
  kind.className = 'suggest-kind';
  kind.textContent = suggestion.kind;
  head.append(chip, kind);
  el.appendChild(head);

  const preview = document.createElement('div');
  preview.className = 'suggest-preview';
  if (suggestion.kind === 'insert') {
    const ins = document.createElement('span');
    ins.className = 'suggest-add';
    ins.textContent = `+ ${shorten(suggestion.text)}`;
    preview.appendChild(ins);
  } else {
    const del = document.createElement('span');
    del.className = 'suggest-del';
    del.textContent = `− ${shorten(suggestion.quotedText)}`;
    preview.appendChild(del);
    if (suggestion.kind === 'replace') {
      const add = document.createElement('span');
      add.className = 'suggest-add';
      add.textContent = `+ ${shorten(suggestion.text)}`;
      preview.appendChild(add);
    }
  }
  if (suggestion.range === null) {
    const orphan = document.createElement('span');
    orphan.className = 'suggest-orphan';
    orphan.textContent = '(target text was deleted)';
    preview.appendChild(orphan);
  }
  el.appendChild(preview);

  const actions = document.createElement('div');
  actions.className = 'suggest-actions';
  if (suggestion.range !== null) {
    actions.appendChild(
      button('Accept', 'primary', () => acceptSuggestion(w.doc, suggestion.id, w.user.name)),
    );
  }
  actions.appendChild(button('Reject', '', () => rejectSuggestion(w.doc, suggestion.id, w.user.name)));
  if (suggestion.author === w.user.name) {
    actions.appendChild(button('Withdraw', 'subtle', () => deleteSuggestion(w.doc, suggestion.id)));
  }
  el.appendChild(actions);

  el.addEventListener('click', () => {
    w.focusedId = suggestion.id;
    if (suggestion.range) {
      w.view.dispatch({
        selection: { anchor: suggestion.range.from, head: suggestion.range.to },
        effects: EditorView.scrollIntoView(suggestion.range.from, { y: 'center' }),
      });
    }
    render();
  });

  return el;
}

function render(): void {
  if (!wiring) {
    return;
  }
  const w = wiring;
  const pending = listSuggestions(w.doc).filter((suggestion) => suggestion.status === 'pending');

  listEl.innerHTML = '';
  for (const suggestion of pending) {
    listEl.appendChild(card(suggestion));
  }
  panel.hidden = pending.length === 0;
  titleEl.textContent = `Review ${pending.length} suggestion${pending.length === 1 ? '' : 's'}`;

  // Keep an open popover glued to its (possibly shifted) anchor, or drop it when
  // the suggestion was resolved/withdrawn/orphaned out from under it.
  if (popoverId) {
    const still = pending.find((s) => s.id === popoverId);
    if (still && still.range) {
      repositionPopover(still.range.from);
    } else {
      closePopover();
    }
  }

  const ranges: SuggestRange[] = pending
    .filter((suggestion) => suggestion.range !== null)
    .map((suggestion) => ({
      id: suggestion.id,
      kind: suggestion.kind,
      from: suggestion.range!.from,
      to: suggestion.range!.to,
      text: suggestion.text,
      focused: suggestion.id === w.focusedId,
    }));
  w.view.dispatch({ effects: setSuggestRanges.of(ranges) });
}

export function wireSuggestions(view: EditorView, doc: Y.Doc, user: { name: string }): () => void {
  const suggestions = doc.getMap(SUGGESTIONS_KEY);
  wiring = { view, doc, user, focusedId: null };

  const observer = () => render();
  suggestions.observeDeep(observer);

  // Text edits move/orphan anchors, so follow them too — debounced.
  const ytext = doc.getText(TEXT_KEY);
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRender = () => {
    if (renderTimer) {
      clearTimeout(renderTimer);
    }
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 150);
  };
  ytext.observe(scheduleRender);

  const onEditorClick = (event: Event) => {
    const marked = (event.target as HTMLElement).closest('[data-suggestion-id]');
    if (marked && wiring) {
      const id = (marked as HTMLElement).dataset.suggestionId!;
      wiring.focusedId = id;
      render();
      openPopover(id); // anchored accept/reject where the text is
    }
  };
  view.dom.addEventListener('click', onEditorClick);

  const onAcceptAll = () => void acceptAll();
  const onRejectAll = () => void rejectAll();
  acceptAllButton.addEventListener('click', onAcceptAll);
  rejectAllButton.addEventListener('click', onRejectAll);

  render();

  return () => {
    suggestions.unobserveDeep(observer);
    ytext.unobserve(scheduleRender);
    if (renderTimer) {
      clearTimeout(renderTimer);
    }
    view.dom.removeEventListener('click', onEditorClick);
    acceptAllButton.removeEventListener('click', onAcceptAll);
    rejectAllButton.removeEventListener('click', onRejectAll);
    closePopover();
    listEl.innerHTML = '';
    panel.hidden = true;
    wiring = null;
  };
}
