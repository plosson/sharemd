import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { remoteEditExtension, wireRemoteEdits } from './remote-edits';
import { commentHighlightExtension, focusThread, setShowResolved, wireComments } from './comments';
import { setPreviewEnabled, wirePreview } from './preview';
import { closeHistory, openHistory } from './history';
import { closeVersions, openVersions } from './versions';
import { openMcpConfig } from './mcp-config';
import { suggestionHighlightExtension, wireSuggestions } from './suggestions';
import { onUrlChange, readUrlState, writeUrlState, type UrlState } from './url-state';
import * as api from './api';
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
const projectSelect = document.querySelector('#project-select')! as HTMLSelectElement;
const docList = document.querySelector('#doc-list')!;
const editorHost = document.querySelector('#editor')!;
const docTitle = document.querySelector('#doc-title')!;
const statusEl = document.querySelector('#status')! as HTMLElement;
const presenceEl = document.querySelector('#presence')!;
const activityEl = document.querySelector('#activity')! as HTMLElement;

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

document.querySelector('#versions-open')!.addEventListener('click', () => {
  if (currentPath) {
    void openVersions(currentPath, user.name);
  }
});

const docSearch = document.querySelector('#doc-search')! as HTMLInputElement;
const searchResults = document.querySelector('#search-results')!;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function clearSearch() {
  docSearch.value = '';
  searchResults.innerHTML = '';
  searchResults.hidden = true;
  docList.hidden = false;
}

async function runSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!currentProject || !trimmed) {
    searchResults.hidden = true;
    searchResults.innerHTML = '';
    docList.hidden = false;
    return;
  }
  let matches: api.SearchMatch[];
  try {
    matches = await api.searchProject(currentProject, trimmed);
  } catch {
    return;
  }
  // A slower query can resolve after the box changed — ignore stale results.
  if (docSearch.value.trim() !== trimmed) {
    return;
  }
  docList.hidden = true;
  searchResults.hidden = false;
  searchResults.innerHTML = '';
  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'search-empty';
    empty.textContent = 'No matches.';
    searchResults.appendChild(empty);
    return;
  }
  for (const match of matches) {
    const full = `${currentProject}/${match.doc}`;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-hit';
    const where = document.createElement('span');
    where.className = 'search-where';
    where.textContent = `${match.doc}:${match.line}`;
    const snip = document.createElement('span');
    snip.className = 'search-snippet';
    snip.textContent = match.snippet;
    row.append(where, snip);
    row.addEventListener('click', () => {
      clearSearch();
      openDocument(full);
    });
    searchResults.appendChild(row);
  }
}

docSearch.addEventListener('input', () => {
  const query = docSearch.value;
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
  searchTimer = setTimeout(() => void runSearch(query), 200);
});
docSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearSearch();
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

/** Show which other peers are actively composing, and where — clears when they go idle. */
function renderActivity(provider: WebsocketProvider) {
  const writers: string[] = [];
  for (const [clientId, state] of provider.awareness.getStates()) {
    if (clientId === provider.awareness.clientID) {
      continue; // don't narrate your own writing back to yourself
    }
    const peer = (state as { user?: { name?: string; status?: string; section?: string | null } }).user;
    if (peer?.name && peer.status === 'composing') {
      writers.push(peer.section ? `${peer.name} is writing in §${peer.section}` : `${peer.name} is writing…`);
    }
  }
  activityEl.textContent = writers.join('  ·  ');
  activityEl.hidden = writers.length === 0;
}

/**
 * `urlMode` — how this navigation reaches the URL: 'push' (user action, new
 * history entry, clears any focused comment), 'replace' (boot: normalize the
 * hash, keep comment focus from the URL), 'none' (hashchange already has it).
 */
function teardownEditor() {
  closeHistory();
  closeVersions();
  activityEl.hidden = true;
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
  const renderAwareness = () => {
    renderPresence(provider);
    renderActivity(provider);
  };
  provider.awareness.on('change', renderAwareness);
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
      suggestionHighlightExtension(),
    ],
    parent: editorHost,
  });
  const cleanupRemoteEdits = wireRemoteEdits(view, ytext, provider, doc.clientID);
  const cleanupComments = wireComments(view, doc, user, (state) =>
    writeUrlState({ comment: state.comment, resolved: state.resolved }),
  );
  const cleanupSuggestions = wireSuggestions(view, doc, user);
  const cleanupPreview = wirePreview(ytext, (enabled) => writeUrlState({ preview: enabled }));
  const cleanup = () => {
    cleanupRemoteEdits();
    cleanupComments();
    cleanupSuggestions();
    cleanupPreview();
  };

  current = { provider, view, doc, cleanup };
  // Test hook: lets e2e drive precise editor selections.
  (globalThis as { mdioView?: EditorView }).mdioView = view;
  renderAwareness();
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
  clearSearch();
  docs = project ? (await api.listDocs(project)).map((rel) => `${project}/${rel}`) : [];
  renderProjectSelect();
  renderDocList();
}

async function navigate(state: UrlState, urlMode: 'replace' | 'none') {
  const project = state.doc?.split('/')[0] ?? state.project;
  const target = project && projects.includes(project) ? project : projects[0] ?? null;
  if (target !== currentProject) {
    await loadProject(target);
  }
  const doc = state.doc && docs.includes(state.doc) ? state.doc : docs[0] ?? null;
  if (doc && doc !== currentPath) {
    // A fallback doc must normalize the URL even on back/forward navigation,
    // or the address bar keeps the stale path.
    openDocument(doc, doc === state.doc && urlMode === 'none' ? 'none' : 'replace');
  } else if (!doc) {
    closeDocument();
    writeUrlState({ doc: null, project: currentProject });
  }
  applyViewState(state);
}

/** Open a project on the doc given (or its first doc), replacing the dead URL. */
async function enterProject(project: string | null, doc?: string) {
  await loadProject(project);
  const target = doc && docs.includes(doc) ? doc : docs[0];
  if (target) {
    openDocument(target, 'replace');
  } else {
    closeDocument();
    writeUrlState({ doc: null, project: currentProject, comment: null });
  }
}

/** Run a CRUD action; API failures (conflicts, reserved names, …) surface as alerts. */
async function attempt(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
}

function wireCrud() {
  projectSelect.addEventListener('change', async () => {
    await loadProject(projectSelect.value);
    if (docs[0]) {
      openDocument(docs[0]);
    } else {
      closeDocument();
      writeUrlState({ doc: null, project: currentProject, comment: null }, { push: true });
    }
  });

  document.querySelector('#project-mcp')!.addEventListener('click', () => {
    if (!currentProject) {
      return;
    }
    // Humans can't contain "/", so <me>/claude is a valid owner/agent suggestion.
    void openMcpConfig(currentProject, `${user.name}/claude`);
  });

  document.querySelector('#project-new')!.addEventListener('click', () => {
    const name = prompt('New project name')?.trim();
    if (!name) {
      return;
    }
    void attempt(async () => {
      await api.createProject(name);
      projects = await api.listProjects();
      await enterProject(name);
    });
  });

  document.querySelector('#project-rename')!.addEventListener('click', () => {
    if (!currentProject) {
      return;
    }
    const from = currentProject;
    const to = prompt('Rename project', from)?.trim();
    if (!to || to === from) {
      return;
    }
    void attempt(async () => {
      const rest = currentPath?.slice(from.length);
      await api.renameProject(from, to);
      projects = await api.listProjects();
      await enterProject(to, rest ? `${to}${rest}` : undefined);
    });
  });

  document.querySelector('#project-delete')!.addEventListener('click', () => {
    if (!currentProject) {
      return;
    }
    const name = currentProject;
    if (!confirm(`Delete project "${name}" and all its documents?`)) {
      return;
    }
    void attempt(async () => {
      await api.deleteProject(name);
      projects = await api.listProjects();
      await enterProject(projects[0] ?? null);
    });
  });

  document.querySelector('#doc-new')!.addEventListener('click', () => {
    if (!currentProject) {
      alert('Create a project first.');
      return;
    }
    const project = currentProject;
    const entered = prompt('Document name (e.g. notes.md or specs/plan.md)')?.trim();
    if (!entered) {
      return;
    }
    const path = /\.(md|markdown|txt)$/i.test(entered) ? entered : `${entered}.md`;
    void attempt(async () => {
      await api.createDoc(project, path);
      await loadProject(project);
      openDocument(`${project}/${path}`);
    });
  });

  document.querySelector('#doc-rename')!.addEventListener('click', () => {
    if (!currentPath || !currentProject) {
      return;
    }
    const project = currentProject;
    const from = currentPath.slice(project.length + 1);
    const entered = prompt('Rename document', from)?.trim();
    if (!entered || entered === from) {
      return;
    }
    const to = /\.(md|markdown|txt)$/i.test(entered) ? entered : `${entered}.md`;
    void attempt(async () => {
      await api.moveDoc(`${project}/${from}`, { path: to });
      await loadProject(project);
      openDocument(`${project}/${to}`, 'replace');
    });
  });

  document.querySelector('#doc-move')!.addEventListener('click', () => {
    if (!currentPath || !currentProject) {
      return;
    }
    const source = currentPath;
    const others = projects.filter((name) => name !== currentProject);
    if (others.length === 0) {
      alert('There is no other project to move to.');
      return;
    }
    const target = prompt(`Move to project (${others.join(', ')})`)?.trim();
    if (!target || target === currentProject) {
      return;
    }
    if (!projects.includes(target)) {
      alert(`No such project: "${target}"`);
      return;
    }
    void attempt(async () => {
      const rel = source.slice(source.indexOf('/') + 1);
      await api.moveDoc(source, { project: target });
      await enterProject(target, `${target}/${rel}`);
    });
  });

  document.querySelector('#doc-delete')!.addEventListener('click', () => {
    if (!currentPath || !currentProject) {
      return;
    }
    const path = currentPath;
    const project = currentProject;
    if (!confirm(`Delete "${path}"?`)) {
      return;
    }
    void attempt(async () => {
      await api.deleteDoc(path);
      await enterProject(project);
    });
  });
}

async function init() {
  projects = await api.listProjects();
  await navigate(readUrlState(), 'replace');
  wireCrud();
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
