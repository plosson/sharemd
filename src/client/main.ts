import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { remoteEditExtension, wireRemoteEdits } from './remote-edits';
import { closeHistory, openHistory } from './history';
import { TEXT_KEY, registerAuthor } from '../shared/blame';

const PALETTE = [
  { color: '#2f7fd1', light: '#2f7fd133' },
  { color: '#1a9c74', light: '#1a9c7433' },
  { color: '#c2571f', light: '#c2571f33' },
  { color: '#8a4bbf', light: '#8a4bbf33' },
  { color: '#c23b64', light: '#c23b6433' },
];

const NAME_KEY = 'sharemd-name';

/** Humans must not contain "/" — it is reserved for the owner/agent convention. */
function usernameError(name: string): string | null {
  if (!name) {
    return 'Enter a name.';
  }
  if (name.includes('/')) {
    return '"/" is reserved for agents (owner/agent) — pick a plain name.';
  }
  if (/\s/.test(name)) {
    return 'No spaces — pick a single word.';
  }
  if (name.length > 40) {
    return 'Keep it under 40 characters.';
  }
  return null;
}

function withColors(name: string) {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  const swatch = PALETTE[Math.abs(hash) % PALETTE.length]!;
  return { name, color: swatch.color, colorLight: swatch.light };
}

/** Name from the URL (?name=, then stripped) or localStorage; null means "must ask". */
function storedUser(): string | null {
  const params = new URLSearchParams(location.search);
  const fromParam = params.get('name')?.trim();
  if (fromParam !== undefined) {
    if (usernameError(fromParam) === null) {
      localStorage.setItem(NAME_KEY, fromParam);
    }
    const url = new URL(location.href);
    url.searchParams.delete('name');
    history.replaceState(null, '', url);
  }
  const stored = localStorage.getItem(NAME_KEY)?.trim() ?? '';
  return usernameError(stored) === null ? stored : null;
}

function promptForUser(): Promise<string> {
  const overlay = document.querySelector('#login')! as HTMLElement;
  const form = document.querySelector('#login-form')! as HTMLFormElement;
  const input = document.querySelector('#login-name')! as HTMLInputElement;
  const errorEl = document.querySelector('#login-error')! as HTMLElement;
  overlay.hidden = false;
  input.focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      const error = usernameError(name);
      if (error) {
        errorEl.textContent = error;
        errorEl.hidden = false;
        input.focus();
        return;
      }
      localStorage.setItem(NAME_KEY, name);
      overlay.hidden = true;
      resolve(name);
    });
  });
}

let user: { name: string; color: string; colorLight: string };
const docList = document.querySelector('#doc-list')!;
const editorHost = document.querySelector('#editor')!;
const docTitle = document.querySelector('#doc-title')!;
const statusEl = document.querySelector('#status')! as HTMLElement;
const presenceEl = document.querySelector('#presence')!;

let current: {
  provider: WebsocketProvider;
  view: EditorView;
  doc: Y.Doc;
  cleanup: () => void;
} | null = null;
let currentPath: string | null = null;

document.querySelector('#history-open')!.addEventListener('click', () => {
  if (currentPath) {
    void openHistory(currentPath);
  }
});

function renderPresence(provider: WebsocketProvider) {
  presenceEl.innerHTML = '';
  for (const state of provider.awareness.getStates().values()) {
    const peer = (state as { user?: { name?: string; color?: string; role?: string } }).user;
    if (!peer?.name) {
      continue;
    }
    const chip = document.createElement('span');
    chip.className = 'peer';
    chip.style.background = peer.color ?? '#888';
    chip.textContent = peer.role === 'agent' ? `🤖 ${peer.name}` : peer.name;
    presenceEl.appendChild(chip);
  }
}

function openDocument(path: string) {
  closeHistory();
  currentPath = path;
  if (current) {
    current.cleanup();
    current.view.destroy();
    current.provider.destroy();
    current.doc.destroy();
    current = null;
  }
  docTitle.textContent = path;
  for (const item of docList.querySelectorAll('li')) {
    item.classList.toggle('active', item.dataset.path === path);
  }

  const doc = new Y.Doc();
  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const provider = new WebsocketProvider(wsBase, path, doc, { disableBc: true });
  const ytext = doc.getText(TEXT_KEY);
  const undoManager = new Y.UndoManager(ytext);

  provider.awareness.setLocalStateField('user', user);
  registerAuthor(doc, { name: user.name, color: user.color, role: 'human' });
  provider.awareness.on('change', () => renderPresence(provider));
  provider.on('status', ({ status }: { status: string }) => {
    statusEl.textContent = status;
    statusEl.dataset.status = status;
  });

  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(ytext, provider.awareness, { undoManager }),
      remoteEditExtension(),
    ],
    parent: editorHost,
  });
  const cleanup = wireRemoteEdits(view, ytext, provider, doc.clientID);

  current = { provider, view, doc, cleanup };
  renderPresence(provider);
}

function renderMe() {
  const me = document.querySelector('#me')! as HTMLElement;
  const meName = document.querySelector('#me-name')! as HTMLElement;
  meName.textContent = user.name;
  meName.style.background = user.color;
  me.hidden = false;
  document.querySelector('#logout')!.addEventListener('click', () => {
    localStorage.removeItem(NAME_KEY);
    location.reload();
  });
}

async function init() {
  const response = await fetch('/api/docs');
  const { docs } = (await response.json()) as { docs: string[] };
  docList.innerHTML = '';
  for (const path of docs) {
    const item = document.createElement('li');
    item.textContent = path;
    item.dataset.path = path;
    item.addEventListener('click', () => openDocument(path));
    docList.appendChild(item);
  }
  const requested = new URLSearchParams(location.search).get('doc');
  const initial = requested && docs.includes(requested) ? requested : docs[0];
  if (initial) {
    openDocument(initial);
  }
}

async function main() {
  const name = storedUser() ?? (await promptForUser());
  user = withColors(name);
  renderMe();
  await init();
}

void main();
