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
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mdio-suggest-ghost';
    span.textContent = this.text;
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
            return Decoration.widget({ widget: new GhostWidget(range.text), side: 1 }).range(range.from);
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
      wiring.focusedId = (marked as HTMLElement).dataset.suggestionId!;
      render();
    }
  };
  view.dom.addEventListener('click', onEditorClick);

  render();

  return () => {
    suggestions.unobserveDeep(observer);
    ytext.unobserve(scheduleRender);
    if (renderTimer) {
      clearTimeout(renderTimer);
    }
    view.dom.removeEventListener('click', onEditorClick);
    listEl.innerHTML = '';
    panel.hidden = true;
    wiring = null;
  };
}
