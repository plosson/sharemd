import * as Y from 'yjs';
import { DocumentSession, type AgentIdentity } from './session';
import { blameLines, type BlameLine } from '../shared/blame';
import {
  addComment,
  commentAuthor,
  deleteComment,
  editComment,
  listThreads,
  replyToComment,
  setResolved,
  type CommentThread,
} from '../shared/comments';

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
    private readonly project: string,
  ) {}

  // ── document lifecycle ────────────────────────────────────────────────

  /**
   * Agent-visible paths are relative to the peer's project; the vault path
   * (and room name) carries the project prefix. Escaping the project is
   * rejected here, before anything reaches the server.
   */
  private vaultPath(path: string): string {
    const cleaned = path.replace(/^\/+/, '');
    if (!cleaned || cleaned.split('/').some((segment) => segment === '..' || segment === '')) {
      throw new Error(`Invalid document path: "${path}" — use a path relative to your project.`);
    }
    return `${this.project}/${cleaned}`;
  }

  async listDocuments(): Promise<string[]> {
    const response = await fetch(
      `${this.serverHttpBase}/api/projects/${encodeURIComponent(this.project)}/docs`,
    );
    if (!response.ok) {
      const detail =
        response.status === 404 ? `project "${this.project}" does not exist on the server` : `HTTP ${response.status}`;
      throw new Error(`Failed to list documents: ${detail}`);
    }
    const { docs } = (await response.json()) as { docs: string[] };
    return docs;
  }

  async openDocument(path: string): Promise<{ path: string; charCount: number }> {
    const vaultPath = this.vaultPath(path);
    const relative = this.relativePath(vaultPath);
    // Agents only ever edit: opening cannot create a document, so fail with
    // guidance instead of hanging on a room the server will refuse.
    const docs = await this.listDocuments();
    if (!docs.includes(relative)) {
      throw new Error(
        `Document "${relative}" does not exist in project "${this.project}". Documents are created, renamed, and deleted by humans in the web UI — call list_documents to see what exists.`,
      );
    }
    if (this.edit) {
      this.abortEdit();
    }
    this.session?.destroy();
    this.session = null;
    this.cursor = null;
    this.matches.clear();

    this.session = await DocumentSession.open(this.serverWsBase, vaultPath, this.identity);
    this.placeCursorAtIndex(this.text().length);
    return { path: this.relativePath(vaultPath), charCount: this.text().length };
  }

  /** Back from a vault path to what the agent sees. */
  private relativePath(vaultPath: string): string {
    return vaultPath.slice(this.project.length + 1);
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

  /** Per-line authorship, computed locally from this peer's CRDT replica. */
  blameDocument(startLine = 1, maxLines = 200): {
    lines: BlameLine[];
    lineCount: number;
    startLine: number;
    endLine: number;
  } {
    const session = this.requireSession();
    const all = blameLines(session.doc);
    const start = Math.max(1, Math.min(startLine, all.length + 1));
    const window = all.slice(start - 1, start - 1 + maxLines);
    return {
      lines: window,
      lineCount: all.length,
      startLine: start,
      endLine: start + window.length - 1,
    };
  }

  /** Exact matching, whitespace and newlines included — trailing text is anchorable too. */
  searchText(query: string, maxResults = 8): MatchResult[] {
    if (!query) {
      return [];
    }
    const content = this.text();
    const results: MatchResult[] = [];
    let fromIndex = 0;
    while (results.length < maxResults) {
      const found = content.indexOf(query, fromIndex);
      if (found < 0) {
        break;
      }
      const id = `m${++this.matchSeq}`;
      this.matches.set(id, {
        id,
        text: query,
        start: this.relativeAt(found, -1),
        end: this.relativeAt(found + query.length),
      });
      results.push({ matchId: id, text: query, ...preview(content, found, query.length) });
      fromIndex = found + query.length;
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

  /** One-shot search + replace: `query` must occur exactly once (no round-trip gap to race). */
  replaceText(query: string, replacement: string): {
    at: number;
    deletedChars: number;
    insertedChars: number;
  } {
    if (this.edit) {
      throw new Error('An edit session is active — commit_edit/abort_edit first.');
    }
    const session = this.requireSession();
    const content = this.text();
    const shortQuery = query.length > 60 ? `${query.slice(0, 60)}…` : query;
    const at = content.indexOf(query);
    if (at < 0) {
      throw new Error(`Text not found: "${shortQuery}".`);
    }
    let occurrences = 1;
    for (let next = content.indexOf(query, at + 1); next >= 0; next = content.indexOf(query, next + 1)) {
      occurrences++;
    }
    if (occurrences > 1) {
      throw new Error(
        `Text occurs ${occurrences} times: "${shortQuery}" — disambiguate with search_text + replace_match.`,
      );
    }
    session.transact(() => {
      session.ytext.delete(at, query.length);
      session.ytext.insert(at, replacement);
    });
    this.placeCursorAtIndex(at + replacement.length);
    return { at, deletedChars: query.length, insertedChars: replacement.length };
  }

  deleteRange(startMatchId: string, endMatchId: string): { deletedChars: number; deletedPreview: string } {
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
    // Echo enough to confirm the right range died, not the whole payload.
    const deletedPreview =
      deletedText.length <= 200 ? deletedText : `${deletedText.slice(0, 150)} … ${deletedText.slice(-40)}`;
    return { deletedChars: to - from, deletedPreview };
  }

  // ── comments ─────────────────────────────────────────────────────────

  addComment(matchId: string, body: string): { commentId: string; quotedText: string } {
    const session = this.requireSession();
    const { from, to } = this.resolveMatch(matchId);
    let commentId = '';
    session.transact(() => {
      commentId = addComment(session.doc, { author: this.identity.name, body, from, to });
    });
    return { commentId, quotedText: this.text().slice(from, to) };
  }

  listComments(input: { includeResolved?: boolean; mentioning?: string }): {
    threads: Array<CommentThread & { currentText: string | null }>;
  } {
    const session = this.requireSession();
    const content = this.text();
    let threads = listThreads(session.doc);
    if (input.includeResolved === false) {
      threads = threads.filter((thread) => !thread.resolved);
    }
    if (input.mentioning) {
      threads = threads.filter((thread) =>
        [thread.root, ...thread.replies].some((comment) => comment.mentions.includes(input.mentioning!)),
      );
    }
    return {
      threads: threads.map((thread) => ({
        ...thread,
        currentText: thread.range ? content.slice(thread.range.from, thread.range.to) : null,
      })),
    };
  }

  replyComment(commentId: string, body: string): { commentId: string } {
    const session = this.requireSession();
    let replyId = '';
    session.transact(() => {
      replyId = replyToComment(session.doc, { author: this.identity.name, body, parentId: commentId });
    });
    return { commentId: replyId };
  }

  /** Edit and delete are author-only (convention-enforced, like all identity here). */
  private requireOwn(commentId: string, verb: string): DocumentSession {
    const session = this.requireSession();
    const author = commentAuthor(session.doc, commentId);
    if (author !== this.identity.name) {
      throw new Error(`Only the author can ${verb} a comment — this one is by "${author}".`);
    }
    return session;
  }

  editComment(commentId: string, body: string): { commentId: string } {
    const session = this.requireOwn(commentId, 'edit');
    session.transact(() => {
      editComment(session.doc, commentId, body);
    });
    return { commentId };
  }

  resolveComment(commentId: string, resolved: boolean): { commentId: string; resolved: boolean } {
    const session = this.requireSession();
    session.transact(() => {
      setResolved(session.doc, commentId, resolved);
    });
    return { commentId, resolved };
  }

  deleteComment(commentId: string): { deleted: string } {
    const session = this.requireOwn(commentId, 'delete');
    session.transact(() => {
      deleteComment(session.doc, commentId);
    });
    return { deleted: commentId };
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
    return this.session ? this.relativePath(this.session.path) : null;
  }

  destroy(): void {
    this.session?.destroy();
    this.session = null;
  }
}
