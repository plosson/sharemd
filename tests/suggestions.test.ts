import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
  acceptSuggestion,
  addSuggestion,
  deleteSuggestion,
  listSuggestions,
  rejectSuggestion,
  suggestionAuthor,
} from '../src/shared/suggestions';
import { TEXT_KEY } from '../src/shared/blame';

/** Two live-syncing peers, like two clients in one room. */
function pair(initialText: string): [Y.Doc, Y.Doc] {
  const a = new Y.Doc({ gc: false });
  const b = new Y.Doc({ gc: false });
  a.getText(TEXT_KEY).insert(0, initialText);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(b, update, 'relay');
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(a, update, 'relay');
  });
  return [a, b];
}

const TEXT = 'alpha bravo charlie delta echo\n';
const text = (doc: Y.Doc) => doc.getText(TEXT_KEY).toString();
const only = (doc: Y.Doc) => listSuggestions(doc)[0]!;

describe('suggestion model', () => {
  test('insert suggestion roundtrips to the other peer as a point anchor', () => {
    const [a, b] = pair(TEXT);
    const at = TEXT.indexOf('bravo');
    const id = addSuggestion(a, { author: 'plosson/claude', kind: 'insert', from: at, to: at, text: 'NEW ' });

    const view = only(b); // read on the OTHER peer
    expect(view.id).toBe(id);
    expect(view.author).toBe('plosson/claude');
    expect(view.kind).toBe('insert');
    expect(view.text).toBe('NEW ');
    expect(view.quotedText).toBe('');
    expect(view.status).toBe('pending');
    expect(view.range).toEqual({ from: at, to: at });
  });

  test('accepting an insert adds the text; blame follows the accepting peer', () => {
    const [a, b] = pair(TEXT);
    const at = TEXT.indexOf('charlie');
    const id = addSuggestion(a, { author: 'plosson/claude', kind: 'insert', from: at, to: at, text: 'very ' });

    acceptSuggestion(b, id, 'plosson'); // the human accepts on their peer
    expect(text(a)).toBe('alpha bravo very charlie delta echo\n');
    expect(only(a).status).toBe('accepted');
    expect(only(a).resolvedBy).toBe('plosson');
  });

  test('accepting a replace swaps the targeted text', () => {
    const [a, b] = pair(TEXT);
    const from = TEXT.indexOf('bravo');
    const id = addSuggestion(a, {
      author: 'plosson/claude',
      kind: 'replace',
      from,
      to: from + 'bravo'.length,
      text: 'BRAVISSIMO',
    });
    expect(only(b).quotedText).toBe('bravo');

    acceptSuggestion(a, id, 'plosson');
    expect(text(b)).toBe('alpha BRAVISSIMO charlie delta echo\n');
    expect(only(b).status).toBe('accepted');
  });

  test('accepting a delete removes the targeted range', () => {
    const [a, b] = pair(TEXT);
    const from = TEXT.indexOf('charlie ');
    const id = addSuggestion(a, { author: 'x', kind: 'delete', from, to: from + 'charlie '.length, text: '' });

    acceptSuggestion(b, id, 'plosson');
    expect(text(a)).toBe('alpha bravo delta echo\n');
  });

  test('rejecting leaves the text untouched but records the decision', () => {
    const [a, b] = pair(TEXT);
    const from = TEXT.indexOf('delta');
    const id = addSuggestion(a, { author: 'x', kind: 'replace', from, to: from + 5, text: 'DELTA' });

    rejectSuggestion(b, id, 'plosson');
    expect(text(a)).toBe(TEXT);
    expect(only(a).status).toBe('rejected');
    expect(only(a).resolvedBy).toBe('plosson');
  });

  test('anchors follow concurrent edits, and accepting still lands in the right place', () => {
    const [a, b] = pair(TEXT);
    const from = TEXT.indexOf('charlie');
    const id = addSuggestion(a, { author: 'x', kind: 'replace', from, to: from + 'charlie'.length, text: 'C' });

    // Peer B inserts before the range: the anchor shifts to keep targeting "charlie".
    b.getText(TEXT_KEY).insert(0, 'PREFIX ');
    const range = only(a).range!;
    expect(text(a).slice(range.from, range.to)).toBe('charlie');

    acceptSuggestion(a, id, 'plosson');
    expect(text(b)).toBe('PREFIX alpha bravo C delta echo\n');
  });

  test('a suggestion whose target is deleted orphans and can no longer be accepted', () => {
    const [a, b] = pair(TEXT);
    const from = TEXT.indexOf('delta');
    const id = addSuggestion(a, { author: 'x', kind: 'replace', from, to: from + 5, text: 'D' });

    b.getText(TEXT_KEY).delete(from - 1, 'delta'.length + 1); // delete the targeted text
    expect(only(a).range).toBeNull();
    expect(() => acceptSuggestion(a, id, 'plosson')).toThrow('target text was deleted');
  });

  test('a resolved suggestion cannot be resolved again', () => {
    const [a] = pair(TEXT);
    const id = addSuggestion(a, { author: 'x', kind: 'insert', from: 0, to: 0, text: 'hi ' });
    acceptSuggestion(a, id, 'plosson');
    expect(() => acceptSuggestion(a, id, 'plosson')).toThrow('already accepted');
    expect(() => rejectSuggestion(a, id, 'plosson')).toThrow('already accepted');
  });

  test('input guards: insert needs text, delete/replace need a range', () => {
    const [a] = pair(TEXT);
    expect(() => addSuggestion(a, { author: 'x', kind: 'insert', from: 0, to: 0, text: '' })).toThrow('non-empty text');
    expect(() => addSuggestion(a, { author: 'x', kind: 'delete', from: 3, to: 3, text: '' })).toThrow('text range');
  });

  test('withdraw removes a pending suggestion for everyone; author is exposed', () => {
    const [a, b] = pair(TEXT);
    const id = addSuggestion(a, { author: 'plosson/ada', kind: 'insert', from: 0, to: 0, text: 'x' });
    expect(suggestionAuthor(a, id)).toBe('plosson/ada');
    deleteSuggestion(b, id);
    expect(listSuggestions(a)).toHaveLength(0);
    expect(() => suggestionAuthor(a, id)).toThrow('Unknown suggestion');
  });

  test('suggestions sort by anchor position, orphans last', () => {
    const [a] = pair(TEXT);
    const late = addSuggestion(a, { author: 'x', kind: 'replace', from: 20, to: 25, text: 'L' });
    const orphan = addSuggestion(a, { author: 'x', kind: 'replace', from: 6, to: 11, text: 'O' });
    const early = addSuggestion(a, { author: 'x', kind: 'insert', from: 0, to: 0, text: 'E' });
    a.getText(TEXT_KEY).delete(6, 5); // orphan the middle one

    expect(listSuggestions(a).map((s) => s.id)).toEqual([early, late, orphan]);
  });
});
