import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import { remoteEditExtension, wireEditHighlights, type EditAuthor } from './remote-edits';
import { AUTHORS_KEY, TEXT_KEY, type AuthorInfo } from '../shared/blame';

/**
 * History mode: replays a document's append-only update log in a read-only
 * editor. The slider scrubs to any point; play steps through updates with
 * roughly original pacing, flashing each edit in its author's color (identity
 * resolved from the doc's `authors` map — no awareness in a replay).
 */

interface LogEntry {
  ts: number;
  update: Uint8Array;
}

/** Playback gap between entries, derived from recorded time but kept watchable. */
const MIN_STEP_MS = 40;
const MAX_STEP_MS = 800;

const overlay = document.querySelector('#history')! as HTMLElement;
const titleEl = document.querySelector('#history-title')!;
const editorHost = document.querySelector('#history-editor')!;
const slider = document.querySelector('#history-slider')! as HTMLInputElement;
const posEl = document.querySelector('#history-pos')!;
const playButton = document.querySelector('#history-play')! as HTMLButtonElement;
const closeButton = document.querySelector('#history-close')! as HTMLButtonElement;

let session: {
  entries: LogEntry[];
  index: number;
  doc: Y.Doc;
  view: EditorView;
  detachHighlights: () => void;
  playTimer: ReturnType<typeof setTimeout> | null;
} | null = null;

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchLog(path: string): Promise<LogEntry[]> {
  const response = await fetch(`/api/history/${path}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const text = await response.text();
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const { ts, update } = JSON.parse(line) as { ts: number; update: string };
      return { ts, update: decodeBase64(update) };
    });
}

/** Build the replay doc and editor with the first `index` log entries applied. */
function buildAt(entries: LogEntry[], index: number): void {
  teardownEditor();
  const doc = new Y.Doc({ gc: false });
  for (const entry of entries.slice(0, index)) {
    Y.applyUpdate(doc, entry.update);
  }
  const ytext = doc.getText(TEXT_KEY);
  const authors = doc.getMap<AuthorInfo>(AUTHORS_KEY);
  const view = new EditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        yCollab(ytext, null, { undoManager: false }),
        remoteEditExtension(),
      ],
    }),
    parent: editorHost,
  });
  // ownClient -1 matches no real peer, so every replayed edit gets flashed.
  const detachHighlights = wireEditHighlights(view, ytext, -1, (client): EditAuthor | undefined => {
    const info = authors.get(String(client));
    return info && { name: info.name, color: info.color };
  });
  session = { entries, index, doc, view, detachHighlights, playTimer: session?.playTimer ?? null };
  renderPosition();
}

function teardownEditor(): void {
  if (!session) {
    return;
  }
  session.detachHighlights();
  session.view.destroy();
  session.doc.destroy();
}

function renderPosition(): void {
  if (!session) {
    return;
  }
  const { entries, index } = session;
  slider.max = String(entries.length);
  slider.value = String(index);
  const at = entries[index - 1];
  posEl.textContent = `${index}/${entries.length} — ${at ? new Date(at.ts).toLocaleString() : ''}`;
}

function stopPlayback(): void {
  if (session?.playTimer) {
    clearTimeout(session.playTimer);
    session.playTimer = null;
  }
  playButton.textContent = '▶ play';
}

/** Apply the next entry to the live replay doc (highlights flash), then reschedule. */
function stepPlayback(): void {
  if (!session) {
    return;
  }
  if (session.index >= session.entries.length) {
    stopPlayback();
    return;
  }
  const previous = session.entries[session.index - 1]!;
  const next = session.entries[session.index]!;
  Y.applyUpdate(session.doc, next.update);
  session.index += 1;
  renderPosition();
  const gap = Math.min(Math.max(next.ts - previous.ts, MIN_STEP_MS), MAX_STEP_MS);
  session.playTimer = setTimeout(stepPlayback, gap);
}

playButton.addEventListener('click', () => {
  if (!session) {
    return;
  }
  if (session.playTimer) {
    stopPlayback();
    return;
  }
  if (session.index >= session.entries.length) {
    buildAt(session.entries, 1); // replay from the beginning
  }
  playButton.textContent = '⏸ pause';
  session.playTimer = setTimeout(stepPlayback, MIN_STEP_MS);
});

slider.addEventListener('input', () => {
  if (!session) {
    return;
  }
  stopPlayback();
  buildAt(session.entries, Math.max(1, Number(slider.value)));
});

closeButton.addEventListener('click', closeHistory);

export function closeHistory(): void {
  if (!session) {
    return;
  }
  stopPlayback();
  teardownEditor();
  session = null;
  overlay.hidden = true;
}

export async function openHistory(path: string): Promise<void> {
  closeHistory();
  const entries = await fetchLog(path);
  if (entries.length === 0) {
    return;
  }
  titleEl.textContent = `${path} — history`;
  overlay.hidden = false;
  buildAt(entries, entries.length);
}
