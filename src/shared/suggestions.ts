import * as Y from 'yjs';
import { TEXT_KEY } from './blame';

/**
 * Suggested edits ("suggesting mode"): an agent proposes a change instead of
 * mutating the text, and a human accepts or rejects it. Suggestions live in the
 * document's own Y.Doc under the `suggestions` key — a Y.Map of suggestionId →
 * Y.Map of fields — so they sync, merge, and persist through the same machinery
 * as the text and comments.
 *
 * Each suggestion anchors to the text with Yjs relative positions (like
 * comments), so it follows edits by other peers; if the anchored text is deleted
 * the suggestion reports itself orphaned and can no longer be accepted. `insert`
 * anchors a single point (from === to); `delete` / `replace` bracket a range.
 *
 * Accepting applies the change to `content` in the accepting peer's own doc — so
 * blame attributes the resulting text to whoever accepted (the human taking
 * responsibility), while the suggestion keeps `author` for provenance. This is a
 * deliberate v1 choice: CRDT blame is by inserting clientID, and the acceptor is
 * the one inserting.
 */

export const SUGGESTIONS_KEY = 'suggestions';

export type SuggestionKind = 'insert' | 'delete' | 'replace';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface SuggestionView {
  id: string;
  author: string;
  kind: SuggestionKind;
  /** Proposed inserted/replacement text ('' for a delete). */
  text: string;
  /** Snapshot of the targeted text at creation ('' for an insert). */
  quotedText: string;
  status: SuggestionStatus;
  createdAt: number;
  resolvedBy: string | null;
  /** Current anchor range, or null when the targeted text was deleted. Insert: from === to. */
  range: { from: number; to: number } | null;
}

type Fields = Y.Map<unknown>;

function suggestionsMap(doc: Y.Doc): Y.Map<Fields> {
  return doc.getMap<Fields>(SUGGESTIONS_KEY);
}

let idSeq = 0;

function newSuggestionId(): string {
  return `s-${Date.now().toString(36)}-${(++idSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function encodeAnchor(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeAnchor(encoded: string): Y.RelativePosition {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return Y.decodeRelativePosition(bytes);
}

function requireSuggestion(doc: Y.Doc, id: string): Fields {
  const fields = suggestionsMap(doc).get(id);
  if (!fields) {
    throw new Error(`Unknown suggestion: ${id}`);
  }
  return fields;
}

export function addSuggestion(
  doc: Y.Doc,
  input: { author: string; kind: SuggestionKind; from: number; to: number; text: string },
): string {
  const ytext = doc.getText(TEXT_KEY);
  const from = Math.max(0, Math.min(input.from, ytext.length));
  const to = Math.max(from, Math.min(input.to, ytext.length));
  if (input.kind === 'insert') {
    if (!input.text) {
      throw new Error('An insert suggestion needs non-empty text to propose.');
    }
  } else if (to === from) {
    throw new Error(`A ${input.kind} suggestion needs a non-empty text range to target.`);
  }
  const id = newSuggestionId();
  doc.transact(() => {
    const fields = new Y.Map<unknown>();
    fields.set('author', input.author);
    fields.set('kind', input.kind);
    fields.set('text', input.text);
    fields.set('quotedText', input.kind === 'insert' ? '' : ytext.toString().slice(from, to));
    fields.set('status', 'pending');
    fields.set('createdAt', Date.now());
    fields.set('resolvedBy', null);
    // Insert anchors a single point; delete/replace bracket the text (end sticks
    // to the last targeted char, so edits just after the range stay outside it).
    fields.set('anchorStart', encodeAnchor(Y.createRelativePositionFromTypeIndex(ytext, from)));
    fields.set(
      'anchorEnd',
      encodeAnchor(Y.createRelativePositionFromTypeIndex(ytext, to, input.kind === 'insert' ? 0 : -1)),
    );
    suggestionsMap(doc).set(id, fields);
  });
  return id;
}

function rangeOf(doc: Y.Doc, fields: Fields, kind: SuggestionKind): { from: number; to: number } | null {
  const start = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(fields.get('anchorStart') as string), doc);
  const end = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(fields.get('anchorEnd') as string), doc);
  if (start === null || end === null) {
    return null;
  }
  if (kind === 'insert') {
    return { from: start.index, to: start.index };
  }
  return end.index > start.index ? { from: start.index, to: end.index } : null;
}

function viewOf(doc: Y.Doc, id: string, fields: Fields): SuggestionView {
  const kind = (fields.get('kind') as SuggestionKind) ?? 'insert';
  return {
    id,
    author: (fields.get('author') as string) ?? 'unknown',
    kind,
    text: (fields.get('text') as string) ?? '',
    quotedText: (fields.get('quotedText') as string) ?? '',
    status: (fields.get('status') as SuggestionStatus) ?? 'pending',
    createdAt: (fields.get('createdAt') as number) ?? 0,
    resolvedBy: (fields.get('resolvedBy') as string | null) ?? null,
    range: rangeOf(doc, fields, kind),
  };
}

/** All suggestions, sorted by current anchor position (orphaned ones last). */
export function listSuggestions(doc: Y.Doc): SuggestionView[] {
  const views: SuggestionView[] = [];
  for (const [id, fields] of suggestionsMap(doc).entries()) {
    views.push(viewOf(doc, id, fields));
  }
  return views.sort((a, b) => {
    if (a.range && b.range) {
      return a.range.from - b.range.from || a.createdAt - b.createdAt;
    }
    if (a.range !== null || b.range !== null) {
      return a.range ? -1 : 1;
    }
    return a.createdAt - b.createdAt;
  });
}

export function suggestionAuthor(doc: Y.Doc, id: string): string {
  return requireSuggestion(doc, id).get('author') as string;
}

/**
 * Apply a pending suggestion to the text in this peer's doc and mark it accepted.
 * Throws if it is already resolved or its target text was deleted (orphaned).
 */
export function acceptSuggestion(doc: Y.Doc, id: string, by: string): void {
  const fields = requireSuggestion(doc, id);
  if (fields.get('status') !== 'pending') {
    throw new Error(`Suggestion ${id} is already ${fields.get('status')}.`);
  }
  const kind = fields.get('kind') as SuggestionKind;
  const range = rangeOf(doc, fields, kind);
  if (!range) {
    throw new Error(`Suggestion ${id} can no longer apply — its target text was deleted.`);
  }
  const text = fields.get('text') as string;
  const ytext = doc.getText(TEXT_KEY);
  doc.transact(() => {
    if (kind === 'delete' || kind === 'replace') {
      ytext.delete(range.from, range.to - range.from);
    }
    if (kind === 'insert' || kind === 'replace') {
      ytext.insert(range.from, text);
    }
    fields.set('status', 'accepted');
    fields.set('resolvedBy', by);
  });
}

/** Mark a pending suggestion rejected, leaving the text untouched. */
export function rejectSuggestion(doc: Y.Doc, id: string, by: string): void {
  const fields = requireSuggestion(doc, id);
  if (fields.get('status') !== 'pending') {
    throw new Error(`Suggestion ${id} is already ${fields.get('status')}.`);
  }
  doc.transact(() => {
    fields.set('status', 'rejected');
    fields.set('resolvedBy', by);
  });
}

/** Remove a suggestion entirely (used to withdraw one's own pending proposal). */
export function deleteSuggestion(doc: Y.Doc, id: string): void {
  requireSuggestion(doc, id);
  doc.transact(() => {
    suggestionsMap(doc).delete(id);
  });
}
