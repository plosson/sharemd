import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { remoteEditExtension, wireRemoteEdits } from './remote-edits';
import { commentHighlightExtension, focusThread, setShowResolved, wireComments } from './comments';
import { setMode, wirePreview } from './preview';
import { closeHistory, openHistory } from './history';
import { closeVersions, openVersions } from './versions';
import { openMcpConfig } from './mcp-config';
import { suggestionHighlightExtension, wireSuggestions } from './suggestions';
import { onUrlChange, readUrlState, writeUrlState, type UrlState } from './url-state';
import { askChoice, askConfirm, askText, toast } from './dialogs';
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
const appEl = document.querySelector('#app')! as HTMLElement;
const projectSelect = document.querySelector('#project-select')! as HTMLSelectElement;
const docList = document.querySelector('#doc-list')! as HTMLElement;
const editorHost = document.querySelector('#editor')!;
const headerEl = document.querySelector('#header')! as HTMLElement;
const workspaceEl = document.querySelector('#workspace')! as HTMLElement;
const emptyStateEl = document.querySelector('#empty-state')! as HTMLElement;
const breadcrumbEl = document.querySelector('#breadcrumb')! as HTMLElement;
const crumbProjectEl = document.querySelector('#crumb-project')!;
const crumbTitleEl = document.querySelector('#crumb-title')!;
const statusDot = document.querySelector('#status-dot')! as HTMLElement;
const presenceEl = document.querySelector('#presence')!;
const activityEl = document.querySelector('#activity')! as HTMLElement;
const docSearch = document.querySelector('#doc-search')! as HTMLInputElement;
const docNewButton = document.querySelector('#doc-new')! as HTMLButtonElement;
const projectMenuEl = document.querySelector('#project-menu')! as HTMLElement;

let current: {
  provider: WebsocketProvider;
  view: EditorView;
  doc: Y.Doc;
  cleanup: () => void;
} | null = null;
let currentPath: string | null = null;

/** Dim markdown syntax so prose reads first; keep code monospaced. */
const markdownProse = HighlightStyle.define([
  { tag: tags.processingInstruction, color: 'var(--ink-faint)' },
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.3em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  {
    tag: tags.monospace,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    background: 'var(--accent-soft)',
    borderRadius: '3px',
  },
  { tag: tags.quote, color: 'var(--ink-soft)' },
]);

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

/** First letter of the peer's own name (agents drop the owner/ prefix). */
function peerInitial(name: string): string {
  const own = name.split('/').pop() ?? name;
  return (own[0] ?? '?').toUpperCase();
}

function renderPresence(provider: WebsocketProvider) {
  presenceEl.innerHTML = '';
  for (const state of provider.awareness.getStates().values()) {
    const peer = (state as { user?: { name?: string; color?: string; role?: string } }).user;
    if (!peer?.name) {
      continue;
    }
    const avatar = document.createElement('span');
    avatar.className = peer.role === 'agent' ? 'avatar agent' : 'avatar human';
    avatar.style.background = peer.color ?? '#888';
    avatar.textContent = peerInitial(peer.name);
    avatar.title = peer.name;
    presenceEl.appendChild(avatar);
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

/** Title shown in the breadcrumb: the document's first heading, else its filename. */
function docTitle(path: string, text: string): string {
  const heading = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text);
  return heading ? heading[1]!.trim() : path.slice(path.lastIndexOf('/') + 1);
}

function renderBreadcrumb(path: string, text: string): void {
  crumbProjectEl.textContent = path.split('/')[0]!;
  crumbTitleEl.textContent = docTitle(path, text);
  breadcrumbEl.title = path; // raw path lives in the tooltip now
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

/** Centered empty state in the main pane — no project yet, or an empty project. */
function showEmptyState(): void {
  headerEl.hidden = true;
  workspaceEl.hidden = true;
  emptyStateEl.hidden = false;

  const box = document.createElement('div');
  box.className = 'empty-box';
  const heading = document.createElement('h2');
  const sub = document.createElement('p');
  const actions = document.createElement('div');
  actions.className = 'empty-actions';

  if (currentProject) {
    heading.textContent = currentProject;
    sub.textContent = 'No documents yet';
    actions.append(
      emptyButton('＋ Create a document', 'primary', () => void newDocFlow()),
      emptyButton('Connect an agent', 'ghost', () => openMcpConfig(currentProject!, `${user.name}/claude`)),
    );
  } else {
    heading.textContent = 'Welcome to mdio';
    sub.textContent = 'Live markdown for humans and AI agents. Create a project to begin.';
    actions.append(emptyButton('＋ Create your first project', 'primary', () => void newProjectFlow()));
  }

  box.append(heading, sub, actions);
  emptyStateEl.replaceChildren(box);
}

function emptyButton(label: string, kind: 'primary' | 'ghost', onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `empty-btn ${kind}`;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function closeDocument() {
  teardownEditor();
  showEmptyState();
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
  headerEl.hidden = false;
  workspaceEl.hidden = false;
  emptyStateEl.hidden = true;
  emptyStateEl.replaceChildren();
  for (const item of docList.querySelectorAll('li')) {
    item.classList.toggle('active', item.dataset.path === path);
  }

  const doc = new Y.Doc();
  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const provider = new WebsocketProvider(wsBase, path, doc, { disableBc: true });
  const ytext = doc.getText(TEXT_KEY);
  const undoManager = new Y.UndoManager(ytext);

  renderBreadcrumb(path, ytext.toString());
  let titleTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshTitle = () => {
    if (titleTimer) {
      clearTimeout(titleTimer);
    }
    titleTimer = setTimeout(() => renderBreadcrumb(path, ytext.toString()), 300);
  };
  ytext.observe(refreshTitle);

  provider.awareness.setLocalStateField('user', user);
  registerAuthor(doc, { name: user.name, color: user.color, role: 'human' });
  const renderAwareness = () => {
    renderPresence(provider);
    renderActivity(provider);
  };
  provider.awareness.on('change', renderAwareness);
  provider.on('status', ({ status }: { status: string }) => {
    statusDot.dataset.status = status;
    statusDot.title = status;
  });

  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      basicSetup,
      markdown(),
      syntaxHighlighting(markdownProse),
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
  const cleanupPreview = wirePreview(ytext, (mode) => writeUrlState({ mode }));
  const cleanup = () => {
    ytext.unobserve(refreshTitle);
    if (titleTimer) {
      clearTimeout(titleTimer);
    }
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
  setMode(state.mode);
  setShowResolved(state.resolved);
  focusThread(state.comment);
}

let projects: string[] = [];
let currentProject: string | null = null;
let docs: string[] = [];

/** Sidebar chrome that only makes sense inside a project (search, new-doc, ⋯). */
function renderSidebar(): void {
  const inProject = currentProject !== null;
  docSearch.hidden = !inProject;
  docNewButton.hidden = !inProject;
  projectMenuEl.hidden = !inProject;
}

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
  renderSidebar();
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

/** Run a CRUD action; API failures (conflicts, reserved names, …) surface as toasts. */
async function attempt(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), { tone: 'error' });
  }
}

/** Refetch the project list (and current docs) — for focus and external changes. */
async function refreshProjects(): Promise<void> {
  let latest: string[];
  try {
    latest = await api.listProjects();
  } catch {
    return;
  }
  projects = latest;
  if (currentProject && projects.includes(currentProject)) {
    docs = (await api.listDocs(currentProject)).map((rel) => `${currentProject}/${rel}`);
  }
  renderProjectSelect();
  renderDocList();
}

// ── CRUD flows (shared by the menus, sidebar buttons, and empty states) ──────

async function newProjectFlow(): Promise<void> {
  const name = (await askText({ title: 'New project', hint: 'Name for the new project', confirmLabel: 'Create' }))?.trim();
  if (!name) {
    return;
  }
  await attempt(async () => {
    await api.createProject(name);
    projects = await api.listProjects();
    await enterProject(name);
    toast(`Created ${name}`);
  });
}

async function renameProjectFlow(): Promise<void> {
  if (!currentProject) {
    return;
  }
  const from = currentProject;
  const to = (await askText({ title: 'Rename project', initial: from, confirmLabel: 'Rename' }))?.trim();
  if (!to || to === from) {
    return;
  }
  await attempt(async () => {
    const rest = currentPath?.slice(from.length);
    await api.renameProject(from, to);
    projects = await api.listProjects();
    await enterProject(to, rest ? `${to}${rest}` : undefined);
    toast(`Renamed to ${to}`);
  });
}

async function deleteProjectFlow(): Promise<void> {
  if (!currentProject) {
    return;
  }
  const name = currentProject;
  const ok = await askConfirm({
    title: `Delete project “${name}”?`,
    body: 'This deletes the project and all of its documents. This cannot be undone.',
    confirmLabel: 'Delete project',
    danger: true,
  });
  if (!ok) {
    return;
  }
  await attempt(async () => {
    await api.deleteProject(name);
    projects = await api.listProjects();
    await enterProject(projects[0] ?? null);
    toast(`Deleted ${name}`);
  });
}

async function newDocFlow(): Promise<void> {
  if (!currentProject) {
    toast('Create a project first.', { tone: 'error' });
    return;
  }
  const project = currentProject;
  const entered = (
    await askText({ title: 'New document', hint: 'e.g. notes.md or specs/plan.md', confirmLabel: 'Create' })
  )?.trim();
  if (!entered) {
    return;
  }
  const path = /\.(md|markdown|txt)$/i.test(entered) ? entered : `${entered}.md`;
  await attempt(async () => {
    await api.createDoc(project, path);
    await loadProject(project);
    openDocument(`${project}/${path}`);
    toast(`Created ${path}`);
  });
}

async function renameDocFlow(): Promise<void> {
  if (!currentPath || !currentProject) {
    return;
  }
  const project = currentProject;
  const from = currentPath.slice(project.length + 1);
  const entered = (await askText({ title: 'Rename document', initial: from, confirmLabel: 'Rename' }))?.trim();
  if (!entered || entered === from) {
    return;
  }
  const to = /\.(md|markdown|txt)$/i.test(entered) ? entered : `${entered}.md`;
  await attempt(async () => {
    await api.moveDoc(`${project}/${from}`, { path: to });
    await loadProject(project);
    openDocument(`${project}/${to}`, 'replace');
    toast(`Renamed to ${to}`);
  });
}

async function moveDocFlow(): Promise<void> {
  if (!currentPath || !currentProject) {
    return;
  }
  const source = currentPath;
  const others = projects.filter((name) => name !== currentProject);
  if (others.length === 0) {
    toast('There is no other project to move to.', { tone: 'error' });
    return;
  }
  const target = await askChoice({
    title: 'Move to project',
    hint: 'Pick the project to move this document into.',
    options: others.map((name) => ({ value: name, label: name })),
  });
  if (!target) {
    return;
  }
  await attempt(async () => {
    const rel = source.slice(source.indexOf('/') + 1);
    await api.moveDoc(source, { project: target });
    await enterProject(target, `${target}/${rel}`);
    toast(`Moved to ${target}`);
  });
}

async function deleteDocFlow(): Promise<void> {
  if (!currentPath || !currentProject) {
    return;
  }
  const path = currentPath;
  const project = currentProject;
  const name = path.slice(project.length + 1);
  const ok = await askConfirm({
    title: `Delete “${name}”?`,
    body: 'This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) {
    return;
  }
  await attempt(async () => {
    await api.deleteDoc(path);
    await enterProject(project);
    toast(`Deleted ${name}`);
  });
}

/** A plain-DOM dropdown: toggle button + positioned list, closes on outside click / Escape. */
function wireMenu(menuSelector: string): void {
  const menu = document.querySelector(menuSelector)! as HTMLElement;
  const toggle = menu.querySelector('.menu-toggle')! as HTMLButtonElement;
  const list = menu.querySelector('.menu-list')! as HTMLElement;
  const setOpen = (open: boolean) => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    setOpen(list.hidden);
  });
  list.addEventListener('click', () => setOpen(false));
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node)) {
      setOpen(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
    }
  });
}

function wireCrud() {
  wireMenu('#project-menu');
  wireMenu('#doc-menu');

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

  document.querySelector('#project-new')!.addEventListener('click', () => void newProjectFlow());
  document.querySelector('#project-rename')!.addEventListener('click', () => void renameProjectFlow());
  document.querySelector('#project-delete')!.addEventListener('click', () => void deleteProjectFlow());
  document.querySelector('#doc-new')!.addEventListener('click', () => void newDocFlow());
  document.querySelector('#doc-rename')!.addEventListener('click', () => void renameDocFlow());
  document.querySelector('#doc-move')!.addEventListener('click', () => void moveDocFlow());
  document.querySelector('#doc-delete')!.addEventListener('click', () => void deleteDocFlow());

  // A project created (or removed) in another tab should appear on return.
  window.addEventListener('focus', () => void refreshProjects());
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
  appEl.hidden = false;
  renderMe();
  await init();
}

void main();
