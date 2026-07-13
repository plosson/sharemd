import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { remoteEditExtension, wireRemoteEdits } from './remote-edits';
import { commentHighlightExtension, focusThread, setShowResolved, wireComments } from './comments';
import { setPreviewEnabled, wirePreview } from './preview';
import { closeHistory, openHistory } from './history';
import { onUrlChange, readUrlState, writeUrlState, type UrlState } from './url-state';
import { TEXT_KEY, registerAuthor } from '../shared/blame';

const PALETTE = [
  { color: '#2f7fd1', light: '#2f7fd133' },
  { color: '#1a9c74', light: '#1a9c7433' },
  { color: '#c2571f', light: '#c2571f33' },
  { color: '#8a4bbf', light: '#8a4bbf33' },
  { color: '#c23b64', light: '#c23b6433' },
];

const NAME_KEY = 'mdio-name';

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
  // Read through to the pre-rename key so existing users stay logged in.
  const stored = (localStorage.getItem(NAME_KEY) ?? localStorage.getItem('sharemd-name'))?.trim() ?? '';
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
/** Pre-projects vaults' root documents were migrated here — legacy links follow them. */
const DEFAULT_PROJECT = 'main';
const projectSelect = document.querySelector('#project-select')! as HTMLSelectElement;
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

/**
 * `urlMode` — how this navigation reaches the URL: 'push' (user action, new
 * history entry, clears any focused comment), 'replace' (boot: normalize the
 * hash, keep comment focus from the URL), 'none' (hashchange already has it).
 */
function teardownEditor() {
  closeHistory();
  currentPath = null;
  if (current) {
    current.cleanup();
    current.view.destroy();
    current.provider.destroy();
    current.doc.destroy();
    current = null;
  }
}

function closeDocument() {
  teardownEditor();
  docTitle.textContent = 'Select a document';
  for (const item of docList.querySelectorAll('li')) {
    item.classList.remove('active');
  }
}

function openDocument(path: string, urlMode: 'push' | 'replace' | 'none' = 'push') {
  if (urlMode === 'push') {
    writeUrlState({ doc: path, comment: null }, { push: true });
  } else if (urlMode === 'replace') {
    writeUrlState({ doc: path });
  }
  teardownEditor();
  currentPath = path;
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
      commentHighlightExtension(),
    ],
    parent: editorHost,
  });
  const cleanupRemoteEdits = wireRemoteEdits(view, ytext, provider, doc.clientID);
  const cleanupComments = wireComments(view, doc, user, (state) =>
    writeUrlState({ comment: state.comment, resolved: state.resolved }),
  );
  const cleanupPreview = wirePreview(ytext, (enabled) => writeUrlState({ preview: enabled }));
  const cleanup = () => {
    cleanupRemoteEdits();
    cleanupComments();
    cleanupPreview();
  };

  current = { provider, view, doc, cleanup };
  // Test hook: lets e2e drive precise editor selections.
  (globalThis as { mdioView?: EditorView }).mdioView = view;
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

function applyViewState(state: UrlState) {
  setPreviewEnabled(state.preview);
  setShowResolved(state.resolved);
  focusThread(state.comment);
}

let projects: string[] = [];
let currentProject: string | null = null;
let docs: string[] = [];

function renderProjectSelect() {
  projectSelect.innerHTML = '';
  for (const name of projects) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    projectSelect.appendChild(option);
  }
  projectSelect.hidden = projects.length === 0;
  if (currentProject) {
    projectSelect.value = currentProject;
  }
}

function renderDocList() {
  docList.innerHTML = '';
  for (const path of docs) {
    const item = document.createElement('li');
    // The sidebar is scoped to one project — show paths without its prefix.
    item.textContent = currentProject ? path.slice(currentProject.length + 1) : path;
    item.dataset.path = path;
    item.classList.toggle('active', path === currentPath);
    item.addEventListener('click', () => openDocument(path));
    docList.appendChild(item);
  }
}

async function loadProject(project: string | null): Promise<void> {
  currentProject = project;
  if (project) {
    const response = await fetch(`/api/docs?project=${encodeURIComponent(project)}`);
    ({ docs } = (await response.json()) as { docs: string[] });
  } else {
    docs = [];
  }
  renderProjectSelect();
  renderDocList();
}

/**
 * Map a requested doc to one that exists: legacy pre-projects links name root
 * documents that were migrated into the default project; anything still
 * unknown falls back to the first doc of the current project.
 */
function resolveRequested(requested: string | null): string | null {
  if (requested && docs.includes(requested)) {
    return requested;
  }
  if (requested && !requested.includes('/') && docs.includes(`${DEFAULT_PROJECT}/${requested}`)) {
    return `${DEFAULT_PROJECT}/${requested}`;
  }
  return docs[0] ?? null;
}

async function navigate(state: UrlState, urlMode: 'replace' | 'none') {
  let requested = state.doc;
  if (requested && !requested.includes('/')) {
    requested = `${DEFAULT_PROJECT}/${requested}`; // legacy root-doc link
  }
  const project = requested?.split('/')[0] ?? state.project;
  const target = project && projects.includes(project) ? project : projects[0] ?? null;
  if (target !== currentProject) {
    await loadProject(target);
  }
  const doc = resolveRequested(state.doc);
  if (doc && doc !== currentPath) {
    // A rewritten (legacy or fallback) doc must normalize the URL even on
    // back/forward navigation, or the address bar keeps the stale path.
    openDocument(doc, doc === state.doc && urlMode === 'none' ? 'none' : 'replace');
  } else if (!doc) {
    closeDocument();
    writeUrlState({ doc: null, project: currentProject });
  }
  applyViewState(state);
}

async function init() {
  const response = await fetch('/api/projects');
  ({ projects } = (await response.json()) as { projects: string[] });

  // Legacy ?doc= links migrate into the path, once.
  const params = new URLSearchParams(location.search);
  const legacy = params.get('doc');
  if (legacy) {
    params.delete('doc');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }

  const urlState = readUrlState();
  await navigate({ ...urlState, doc: urlState.doc ?? legacy }, 'replace');

  projectSelect.addEventListener('change', async () => {
    await loadProject(projectSelect.value);
    if (docs[0]) {
      openDocument(docs[0]);
    } else {
      closeDocument();
      writeUrlState({ doc: null, project: currentProject, comment: null }, { push: true });
    }
  });

  // Back/forward and hand-edited URLs, same resolution as the boot path.
  onUrlChange((state) => void navigate(state, 'none'));
}

async function main() {
  const name = storedUser() ?? (await promptForUser());
  user = withColors(name);
  renderMe();
  await init();
}

void main();
