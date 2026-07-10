import * as Y from 'yjs';
import { DocumentSession, type AgentIdentity } from './session';

/**
 * Editing runtime for one agent. Match handles and the cursor are stored as Yjs
 * relative positions, so they stay anchored to the intended characters while
 * humans and other agents edit concurrently. If an anchored range was deleted,
 * resolution falls back to re-finding the exact text.
 */

interface MatchHandle {
  id: string;
  text: string;
  start: Y.RelativePosition;
  end: Y.RelativePosition;
}

interface EditSession {
  mode: 'insert' | 'append';
  /** Sticks to the left of the region so concurrent edits before it stay outside. */
  start: Y.RelativePosition;
  /** Re-created after every append, associated left with the last written char. */
  end: Y.RelativePosition;
  committedChars: number;
}

export interface MatchResult {
  matchId: string;
  text: string;
  before: string;
  after: string;
}

const PREVIEW_CHARS = 40;

function preview(text: string, index: number, length: number): { before: string; after: string } {
  return {
    before: text.slice(Math.max(0, index - PREVIEW_CHARS), index),
    after: text.slice(index + length, index + length + PREVIEW_CHARS),
  };
}

export class AgentRuntime {
  private session: DocumentSession | null = null;
  private cursor: Y.RelativePosition | null = null;
  private readonly matches = new Map<string, MatchHandle>();
  private edit: EditSession | null = null;
  private matchSeq = 0;

  constructor(
    private readonly serverWsBase: string,
    private readonly serverHttpBase: string,
    private readonly identity: AgentIdentity,
  ) {}

  // ── document lifecycle ────────────────────────────────────────────────

  async listDocuments(): Promise<string[]> {
    const response = await fetch(`${this.serverHttpBase}/api/docs`);
    if (!response.ok) {
      throw new Error(`Failed to list documents: HTTP ${response.status}`);
    }
    const { docs } = (await response.json()) as { docs: string[] };
    return docs;
  }

  async openDocument(path: string): Promise<{ path: string; charCount: number }> {
    if (this.edit) {
      this.abortEdit();
    }
    this.session?.destroy();
    this.session = null;
    this.cursor = null;
    this.matches.clear();

    this.session = await DocumentSession.open(this.serverWsBase, path, this.identity);
    this.placeCursorAtIndex(this.text().length);
    return { path, charCount: this.text().length };
  }

  private requireSession(): DocumentSession {
    if (!this.session) {
      throw new Error('No document is open — call open_document first.');
    }
    return this.session;
  }

  private text(): string {
    return this.requireSession().ytext.toString();
  }

  // ── position handling ────────────────────────────────────────────────

  private relativeAt(index: number, assoc: -1 | 0 = 0): Y.RelativePosition {
    const session = this.requireSession();
    const clamped = Math.max(0, Math.min(index, session.ytext.length));
    return Y.createRelativePositionFromTypeIndex(session.ytext, clamped, assoc);
  }

  private absoluteOf(position: Y.RelativePosition): number | null {
    const session = this.requireSession();
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, session.doc);
    if (!absolute || absolute.type !== session.ytext) {
      return null;
    }
    return absolute.index;
  }

  /** Resolve a match to its current range; falls back to exact-text re-find. */
  private resolveMatch(matchId: string): { from: number; to: number; handle: MatchHandle } {
    const handle = this.matches.get(matchId);
    if (!handle) {
      throw new Error(`Unknown matchId: ${matchId} — call search_text again.`);
    }
    const content = this.text();
    const from = this.absoluteOf(handle.start);
    const to = this.absoluteOf(handle.end);
    if (from !== null && to !== null && to >= from && content.slice(from, to) === handle.text) {
      return { from, to, handle };
    }
    const found = content.indexOf(handle.text);
    if (found < 0) {
      throw new Error(`Match ${matchId} ("${handle.text}") no longer exists in the document.`);
    }
    handle.start = this.relativeAt(found, -1);
    handle.end = this.relativeAt(found + handle.text.length);
    return { from: found, to: found + handle.text.length, handle };
  }

  private cursorIndex(): number {
    if (this.cursor) {
      const index = this.absoluteOf(this.cursor);
      if (index !== null) {
        return index;
      }
    }
    return this.text().length;
  }

  private placeCursorAtIndex(index: number): void {
    this.cursor = this.relativeAt(index);
    this.requireSession().setCursor(index);
  }

  // ── reads ────────────────────────────────────────────────────────────

  readDocument(startChar = 0, maxChars = 6000): {
    text: string;
    charCount: number;
    startChar: number;
    endChar: number;
  } {
    const content = this.text();
    const start = Math.max(0, Math.min(startChar, content.length));
    const end = Math.min(content.length, start + maxChars);
    return { text: content.slice(start, end), charCount: content.length, startChar: start, endChar: end };
  }

  searchText(query: string, maxResults = 8): MatchResult[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const content = this.text();
    const results: MatchResult[] = [];
    let fromIndex = 0;
    while (results.length < maxResults) {
      const found = content.indexOf(trimmed, fromIndex);
      if (found < 0) {
        break;
      }
      const id = `m${++this.matchSeq}`;
      this.matches.set(id, {
        id,
        text: trimmed,
        start: this.relativeAt(found, -1),
        end: this.relativeAt(found + trimmed.length),
      });
      results.push({ matchId: id, text: trimmed, ...preview(content, found, trimmed.length) });
      fromIndex = found + trimmed.length;
    }
    return results;
  }

  // ── cursor ───────────────────────────────────────────────────────────

  placeCursor(input: { matchId?: string; edge?: 'start' | 'end'; boundary?: 'start' | 'end' }): {
    cursorAt: number;
    context: { before: string; after: string };
  } {
    let index: number;
    if (input.matchId) {
      const { from, to } = this.resolveMatch(input.matchId);
      index = (input.edge ?? 'start') === 'start' ? from : to;
    } else if (input.boundary) {
      index = input.boundary === 'start' ? 0 : this.text().length;
    } else {
      throw new Error('place_cursor needs either a matchId or a boundary.');
    }
    this.placeCursorAtIndex(index);
    const content = this.text();
    return { cursorAt: index, context: preview(content, index, 0) };
  }

  // ── atomic edits ─────────────────────────────────────────────────────

  insertText(text: string): { insertedChars: number; cursorAt: number } {
    if (this.edit) {
      throw new Error('An edit session is active — use append_text, or commit_edit/abort_edit first.');
    }
    const session = this.requireSession();
    const at = this.cursorIndex();
    session.transact(() => {
      session.ytext.insert(at, text);
    });
    this.placeCursorAtIndex(at + text.length);
    return { insertedChars: text.length, cursorAt: at + text.length };
  }

  replaceMatch(matchId: string, text: string): { replaced: string; insertedChars: number } {
    if (this.edit) {
      throw new Error('An edit session is active — commit_edit/abort_edit first.');
    }
    const session = this.requireSession();
    const { from, to, handle } = this.resolveMatch(matchId);
    session.transact(() => {
      session.ytext.delete(from, to - from);
      session.ytext.insert(from, text);
    });
    this.matches.delete(matchId);
    this.placeCursorAtIndex(from + text.length);
    return { replaced: handle.text, insertedChars: text.length };
  }

  deleteRange(startMatchId: string, endMatchId: string): { deletedChars: number; deletedText: string } {
    if (this.edit) {
      throw new Error('An edit session is active — commit_edit/abort_edit first.');
    }
    const session = this.requireSession();
    const startRange = this.resolveMatch(startMatchId);
    const endRange = this.resolveMatch(endMatchId);
    const from = Math.min(startRange.from, endRange.from);
    const to = Math.max(startRange.to, endRange.to);
    const deletedText = this.text().slice(from, to);
    session.transact(() => {
      session.ytext.delete(from, to - from);
    });
    this.matches.delete(startMatchId);
    this.matches.delete(endMatchId);
    this.placeCursorAtIndex(from);
    return { deletedChars: to - from, deletedText };
  }

  // ── stepwise edit sessions ───────────────────────────────────────────

  beginEdit(mode: 'insert' | 'append'): { mode: string; startAt: number } {
    if (this.edit) {
      throw new Error('An edit session is already active — commit_edit or abort_edit first.');
    }
    const session = this.requireSession();
    const at = mode === 'append' ? this.text().length : this.cursorIndex();
    this.edit = {
      mode,
      start: this.relativeAt(at, -1),
      end: this.relativeAt(at, -1),
      committedChars: 0,
    };
    session.setStatus('composing');
    this.placeCursorAtIndex(at);
    return { mode, startAt: at };
  }

  appendText(text: string): { appendedChars: number; totalChars: number } {
    const edit = this.edit;
    if (!edit) {
      throw new Error('No active edit session — call begin_edit first.');
    }
    if (text.length === 0) {
      return { appendedChars: 0, totalChars: edit.committedChars };
    }
    const session = this.requireSession();
    const at = this.absoluteOf(edit.end) ?? this.text().length;
    session.transact(() => {
      session.ytext.insert(at, text);
    });
    edit.end = this.relativeAt(at + text.length, -1);
    edit.committedChars += text.length;
    this.placeCursorAtIndex(at + text.length);
    return { appendedChars: text.length, totalChars: edit.committedChars };
  }

  commitEdit(): { committedChars: number } {
    const edit = this.edit;
    if (!edit) {
      throw new Error('No active edit session — call begin_edit first.');
    }
    this.edit = null;
    this.requireSession().setStatus('idle');
    return { committedChars: edit.committedChars };
  }

  abortEdit(): { revertedChars: number } {
    const edit = this.edit;
    if (!edit) {
      throw new Error('No active edit session — call begin_edit first.');
    }
    const session = this.requireSession();
    const from = this.absoluteOf(edit.start);
    const to = this.absoluteOf(edit.end);
    let reverted = 0;
    if (from !== null && to !== null && to > from) {
      reverted = to - from;
      session.transact(() => {
        session.ytext.delete(from, to - from);
      });
      this.placeCursorAtIndex(from);
    }
    this.edit = null;
    session.setStatus('idle');
    return { revertedChars: reverted };
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  get openPath(): string | null {
    return this.session?.path ?? null;
  }

  destroy(): void {
    this.session?.destroy();
    this.session = null;
  }
}
