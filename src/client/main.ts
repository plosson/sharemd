import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { remoteEditExtension, wireRemoteEdits } from './remote-edits';

const PALETTE = [
  { color: '#2f7fd1', light: '#2f7fd133' },
  { color: '#1a9c74', light: '#1a9c7433' },
  { color: '#c2571f', light: '#c2571f33' },
  { color: '#8a4bbf', light: '#8a4bbf33' },
  { color: '#c23b64', light: '#c23b6433' },
];

function localUser() {
  const params = new URLSearchParams(location.search);
  const name =
    params.get('name') ||
    localStorage.getItem('sharemd-name') ||
    `Human-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem('sharemd-name', name);
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  const swatch = PALETTE[Math.abs(hash) % PALETTE.length]!;
  return { name, color: swatch.color, colorLight: swatch.light };
}

const user = localUser();
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
  const ytext = doc.getText('content');
  const undoManager = new Y.UndoManager(ytext);

  provider.awareness.setLocalStateField('user', user);
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

void init();
