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
import { suggestionHighlightExtension, wireSuggestions } from './suggestions';
import {
  onUrlChange,
  readDocViewState,
  readView,
  viewPath,
  writeDocViewState,
  writeView,
  type DocViewState,
  type View,
  type ViewMode,
} from './url-state';
import { askChoice, askConfirm, askText, toast } from './dialogs';
import { renderHome } from './home';
import { renderAgents } from './agents';
import { renderSettings } from './settings';
import { applyEditorPrefs } from './prefs';
import { initPalette, openPalette } from './palette';
import type { SurfaceContext } from './surface';
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
/** Optional cursor-color override set in Settings; without it color is hash-derived. */
const COLOR_KEY = 'mdio-color';

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
  // A Settings override wins over the hash-derived color, if it is a valid hex.
  const override = localStorage.getItem(COLOR_KEY);
  if (override && /^#[0-9a-fA-F]{6}$/.test(override)) {
    return { name, color: override, colorLight: `${override}33` };
  }
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
const docNewButton = document.querySelector('#doc-new')! as HTMLButtonElement;
const projectMenuEl = document.querySelector('#project-menu')! as HTMLElement;
const surfaceEl = document.querySelector('#surface')! as HTMLElement;
const projectSectionEl = document.querySelector('#project-section')! as HTMLElement;
const navHomeButton = document.querySelector('#nav-home')! as HTMLButtonElement;
const navInboxButton = document.querySelector('#nav-inbox')! as HTMLButtonElement;
const navAgentsButton = document.querySelector('#nav-agents')! as HTMLButtonElement;
const inboxBadgeEl = document.querySelector('#inbox-badge')! as HTMLElement;
const settingsButton = document.querySelector('#settings-open')! as HTMLButtonElement;

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

// ── History & versions drawer (two tabs sharing one overlay) ────────────────
const drawerEl = document.querySelector('#drawer')! as HTMLElement;
const drawerTitleEl = document.querySelector('#drawer-title')!;
const drawerTabHistory = document.querySelector('#drawer-tab-history')! as HTMLButtonElement;
const drawerTabVersions = document.querySelector('#drawer-tab-versions')! as HTMLButtonElement;
const drawerPaneHistory = document.querySelector('#drawer-history')! as HTMLElement;
const drawerPaneVersions = document.querySelector('#drawer-versions')! as HTMLElement;

function showDrawerTab(tab: 'history' | 'versions'): void {
  drawerTabHistory.classList.toggle('active', tab === 'history');
  drawerTabVersions.classList.toggle('active', tab === 'versions');
  drawerPaneHistory.hidden = tab !== 'history';
  drawerPaneVersions.hidden = tab !== 'versions';
}

/** Open the shared drawer on `tab`, loading both panes for the current document. */
function openDrawer(tab: 'history' | 'versions'): void {
  if (!currentPath) {
    return;
  }
  drawerTitleEl.textContent = currentPath;
  drawerEl.hidden = false;
  showDrawerTab(tab);
  void openHistory(currentPath);
  void openVersions(currentPath, user.name);
}

function closeDrawer(): void {
  drawerEl.hidden = true;
  closeHistory();
  closeVersions();
}

document.querySelector('#drawer-open')!.addEventListener('click', () => openDrawer('history'));
document.querySelector('#drawer-close')!.addEventListener('click', closeDrawer);
drawerTabHistory.addEventListener('click', () => showDrawerTab('history'));
drawerTabVersions.addEventListener('click', () => showDrawerTab('versions'));
drawerEl.addEventListener('mousedown', (event) => {
  if (event.target === drawerEl) {
    closeDrawer();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !drawerEl.hidden) {
    closeDrawer();
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
    const peer = (state as { user?: { name?: string; color?: string; role?: string; status?: string } }).user;
    if (!peer?.name) {
      continue;
    }
    const avatar = document.createElement('span');
    avatar.className = peer.role === 'agent' ? 'avatar agent' : 'avatar human';
    // A subtle pulse marks an agent that is actively composing right now.
    if (peer.role === 'agent' && peer.status === 'composing') {
      avatar.classList.add('composing');
    }
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
  closeDrawer();
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

/** Centered empty state in the main pane — an empty project's doc list. */
function showEmptyState(): void {
  surfaceEl.hidden = true;
  surfaceEl.replaceChildren();
  headerEl.hidden = true;
  workspaceEl.hidden = true;
  emptyStateEl.hidden = false;

  const box = document.createElement('div');
  box.className = 'empty-box';
  const heading = document.createElement('h2');
  const sub = document.createElement('p');
  const actions = document.createElement('div');
  actions.className = 'empty-actions';

  heading.textContent = currentProject ?? 'mdio';
  sub.textContent = 'No documents yet';
  actions.append(
    emptyButton('＋ Create a document', 'primary', () => void newDocFlow()),
    emptyButton('Connect an agent', 'ghost', () => {
      if (currentProject) {
        go({ kind: 'agents', project: currentProject });
      }
    }),
  );

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
  const docView: View = { kind: 'doc', project: path.split('/')[0]!, doc: path };
  if (urlMode === 'push') {
    writeView(docView, { push: true });
  } else if (urlMode === 'replace') {
    writeView(docView);
  }
  teardownEditor();
  currentPath = path;
  surfaceEl.hidden = true;
  surfaceEl.replaceChildren();
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
    writeDocViewState({ comment: state.comment, resolved: state.resolved }),
  );
  const cleanupSuggestions = wireSuggestions(view, doc, user);
  const cleanupPreview = wirePreview(ytext, (mode) => writeDocViewState({ mode }));
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
}

function applyDocViewState(state: DocViewState) {
  setMode(state.mode);
  setShowResolved(state.resolved);
  focusThread(state.comment);
}

/** A sidebar document entry: full vault path plus its list metadata. */
interface SidebarDoc {
  path: string;
  title: string | null;
  modified: number;
}

let projects: string[] = [];
let currentProject: string | null = null;
let docs: SidebarDoc[] = [];

/** Full-path metadata for a project's documents (sidebar + navigation). */
async function fetchDocs(project: string): Promise<SidebarDoc[]> {
  return (await api.listDocs(project)).map((doc) => ({
    path: `${project}/${doc.path}`,
    title: doc.title,
    modified: doc.modified,
  }));
}

/** The label a document shows in lists: its first heading, else its filename. */
function docLabel(doc: SidebarDoc): string {
  return doc.title ?? doc.path.slice(doc.path.lastIndexOf('/') + 1);
}

/** Which sidebar nav item reads as active for the surface being shown. */
function setActiveNav(kind: View['kind']): void {
  navHomeButton.classList.toggle('active', kind === 'home');
  navInboxButton.classList.toggle('active', false); // Inbox lives on Home; never a separate active state
  navAgentsButton.classList.toggle('active', kind === 'agents');
}

/** Show the per-project sidebar section (switcher, docs, agents) only inside a project. */
function renderSidebar(): void {
  projectSectionEl.hidden = currentProject === null;
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
  for (const doc of docs) {
    const item = document.createElement('li');
    // The sidebar shows the document's title (first heading), else its filename.
    item.textContent = docLabel(doc);
    item.dataset.path = doc.path;
    item.title = doc.path;
    item.classList.toggle('active', doc.path === currentPath);
    item.addEventListener('click', () => openDocument(doc.path));
    docList.appendChild(item);
  }
}

async function loadProject(project: string | null): Promise<void> {
  currentProject = project;
  docs = project ? await fetchDocs(project) : [];
  renderProjectSelect();
  renderDocList();
}

/** Mount a full-pane surface (Home / Agents / Settings) into #surface. */
function mountSurface(render: (host: HTMLElement, ctx: SurfaceContext) => void): void {
  teardownEditor();
  headerEl.hidden = true;
  workspaceEl.hidden = true;
  emptyStateEl.hidden = true;
  emptyStateEl.replaceChildren();
  surfaceEl.hidden = false;
  surfaceEl.replaceChildren();
  surfaceEl.scrollTop = 0;
  render(surfaceEl, surfaceContext());
}

/** The router: read the URL, mount the matching surface. */
async function navigate(): Promise<void> {
  const view = readView();
  setActiveNav(view.kind);
  switch (view.kind) {
    case 'home':
      await loadProject(null);
      mountSurface(renderHome);
      return;
    case 'settings':
      await loadProject(null);
      mountSurface(renderSettings);
      return;
    case 'agents':
      await enterAgents(view.project);
      return;
    case 'project':
      await enterProject(view.project);
      return;
    case 'doc':
      await enterDoc(view);
      return;
  }
}

/** Navigate to a view (writes the URL, then renders it). Pushes history by default. */
function go(view: View, opts: { push?: boolean; doc?: Partial<DocViewState> } = {}): void {
  writeView(view, { push: opts.push ?? true, doc: opts.doc });
  void navigate();
}

/** Render a document surface for a doc view, falling back / normalizing the URL. */
async function enterDoc(view: Extract<View, { kind: 'doc' }>): Promise<void> {
  const project = projects.includes(view.project) ? view.project : projects[0] ?? null;
  if (project !== currentProject) {
    await loadProject(project);
  } else {
    renderSidebar();
  }
  const target = docs.some((d) => d.path === view.doc) ? view.doc : docs[0]?.path ?? null;
  if (!target) {
    // The project has no documents: show its empty state, normalize to /project.
    closeDocument();
    if (currentProject) {
      writeView({ kind: 'project', project: currentProject });
    }
    return;
  }
  if (target !== currentPath) {
    // A fallback (target ≠ requested) normalizes the URL; an exact hit keeps it.
    openDocument(target, target === view.doc ? 'none' : 'replace');
  }
  applyDocViewState(readDocViewState());
}

/** Open a project on the doc given (or its first doc), replacing the dead URL. */
async function enterProject(project: string | null, doc?: string): Promise<void> {
  const target = project && projects.includes(project) ? project : projects[0] ?? null;
  if (!target) {
    // No projects at all — Home is the only sensible place.
    go({ kind: 'home' }, { push: false });
    return;
  }
  await loadProject(target);
  const wanted = doc && docs.some((d) => d.path === doc) ? doc : docs[0]?.path;
  if (wanted) {
    openDocument(wanted, 'replace');
  } else {
    closeDocument();
    writeView({ kind: 'project', project: target });
  }
}

/** Render the Agents page for a project (loads the project into the sidebar too). */
async function enterAgents(project: string): Promise<void> {
  const target = projects.includes(project) ? project : projects[0] ?? null;
  if (!target) {
    go({ kind: 'home' }, { push: false });
    return;
  }
  if (target !== currentProject) {
    await loadProject(target);
  }
  if (target !== project) {
    writeView({ kind: 'agents', project: target });
  }
  mountSurface((host, ctx) => renderAgents(host, ctx, target));
}

/** The callback surface renderers use to drive the shell. */
function surfaceContext(): SurfaceContext {
  return {
    me: user,
    projects,
    go,
    newProject: newProjectFlow,
    renameProject: renameProjectByName,
    deleteProject: deleteProjectByName,
    reloadProjects: async () => {
      await refreshProjects();
      return projects;
    },
    refreshInboxBadge,
    setName: changeName,
    setColor: changeColor,
    logout: logoutNow,
  };
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
    docs = await fetchDocs(currentProject);
  }
  renderProjectSelect();
  renderDocList();
}

// ── CRUD flows (shared by the menus, sidebar buttons, surfaces, empty states) ──

/** Starter markdown for a freshly-seeded welcome.md — plain content, no CRDT metadata. */
const WELCOME_SEED = `# Welcome to your project

This is a live document. Everything you type is shared instantly with anyone —
human or AI agent — who opens it.

## Try it

- Select some text and press **＋ comment** in the ⋯ menu to start a thread.
- Invite an agent from the **Agents** page in the sidebar; it joins as a peer,
  with its own cursor, and can propose edits you accept or reject.
- Open **Both** mode (top-right) to see the rendered markdown beside the editor.

Delete this file whenever you're ready to make the project your own.
`;

async function newProjectFlow(): Promise<void> {
  const name = (await askText({ title: 'New project', hint: 'Name for the new project', confirmLabel: 'Create' }))?.trim();
  if (!name) {
    return;
  }
  // Offer a starter document only for the very first project (the first-run path).
  const isFirstProject = projects.length === 0;
  await attempt(async () => {
    await api.createProject(name);
    if (isFirstProject) {
      const seed = await askConfirm({
        title: `Seed “${name}” with a welcome document?`,
        body: 'Adds a welcome.md with a short walkthrough. You can delete it anytime.',
        confirmLabel: 'Add welcome.md',
      });
      if (seed) {
        await api.createDoc(name, 'welcome.md', WELCOME_SEED);
      }
    }
    projects = await api.listProjects();
    await enterProject(name);
    refreshInboxBadge();
    toast(`Created ${name}`);
  });
}

/** Rename the current project (⋯ menu). */
async function renameProjectFlow(): Promise<void> {
  if (currentProject) {
    await renameProjectByName(currentProject);
  }
}

/** Rename a project by name (used by the ⋯ menu and Settings). */
async function renameProjectByName(from: string): Promise<void> {
  const to = (await askText({ title: 'Rename project', initial: from, confirmLabel: 'Rename' }))?.trim();
  if (!to || to === from) {
    return;
  }
  await attempt(async () => {
    const rest = currentProject === from && currentPath ? currentPath.slice(from.length) : null;
    await api.renameProject(from, to);
    projects = await api.listProjects();
    await enterProject(to, rest ? `${to}${rest}` : undefined);
    toast(`Renamed to ${to}`);
  });
}

/** Delete the current project (⋯ menu). */
async function deleteProjectFlow(): Promise<void> {
  if (currentProject) {
    await deleteProjectByName(currentProject);
  }
}

/** Delete a project by name (used by the ⋯ menu and Settings). */
async function deleteProjectByName(name: string): Promise<void> {
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
    refreshInboxBadge();
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

// ── palette actions (⌘K) ──────────────────────────────────────────────────

/** Cycle the doc-view mode Edit → Both → Read via the existing mode buttons. */
function cycleMode(): void {
  if (!currentPath) {
    toast('Open a document first.', { tone: 'error' });
    return;
  }
  const order: ViewMode[] = ['edit', 'both', 'read'];
  const next = order[(order.indexOf(readDocViewState().mode) + 1) % order.length]!;
  (document.querySelector(`#mode-${next}`) as HTMLButtonElement).click();
}

/** Copy the current project's MCP wiring command to the clipboard. */
async function copyMcpConfig(): Promise<void> {
  if (!currentProject) {
    toast('Open a project first.', { tone: 'error' });
    return;
  }
  try {
    const config = await api.getMcpConfig(currentProject, `${user.name}/claude`);
    await navigator.clipboard.writeText(config.configure);
    toast('MCP config copied');
  } catch {
    toast('Could not copy the MCP config.', { tone: 'error' });
  }
}

/** Route "Connect an agent" to a project's Agents page, asking which when several. */
async function connectAgentFlow(): Promise<void> {
  if (currentProject) {
    go({ kind: 'agents', project: currentProject });
    return;
  }
  if (projects.length === 0) {
    toast('Create a project first.', { tone: 'error' });
    return;
  }
  if (projects.length === 1) {
    go({ kind: 'agents', project: projects[0]! });
    return;
  }
  const project = await askChoice({
    title: 'Connect an agent to…',
    hint: 'Pick the project the agent should join.',
    options: projects.map((name) => ({ value: name, label: name })),
  });
  if (project) {
    go({ kind: 'agents', project });
  }
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

  projectSelect.addEventListener('change', () => {
    // Switching projects opens the project page (which opens its first doc).
    go({ kind: 'project', project: projectSelect.value });
  });

  // The old MCP-config modal is now the Agents page.
  document.querySelector('#project-mcp')!.addEventListener('click', () => {
    if (currentProject) {
      go({ kind: 'agents', project: currentProject });
    }
  });

  document.querySelector('#project-new')!.addEventListener('click', () => void newProjectFlow());
  document.querySelector('#project-rename')!.addEventListener('click', () => void renameProjectFlow());
  document.querySelector('#project-delete')!.addEventListener('click', () => void deleteProjectFlow());
  document.querySelector('#doc-new')!.addEventListener('click', () => void newDocFlow());
  document.querySelector('#doc-rename')!.addEventListener('click', () => void renameDocFlow());
  document.querySelector('#doc-move')!.addEventListener('click', () => void moveDocFlow());
  document.querySelector('#doc-delete')!.addEventListener('click', () => void deleteDocFlow());

  // Global chrome: Home, Inbox (Home + focus its block), Agents, Settings.
  navHomeButton.addEventListener('click', () => go({ kind: 'home' }));
  navInboxButton.addEventListener('click', () => go({ kind: 'home' }, { doc: { comment: null } }));
  navAgentsButton.addEventListener('click', () => {
    if (currentProject) {
      go({ kind: 'agents', project: currentProject });
    }
  });
  settingsButton.addEventListener('click', () => go({ kind: 'settings' }));
  document.querySelector('#nav-search')!.addEventListener('click', () => openPalette());
  document.querySelector('#logout')!.addEventListener('click', logoutNow);
  wireShortcutsDialog();

  // A project created (or removed) in another tab should appear on return; the
  // inbox also refreshes on focus and on a slow interval (see startAttentionPolling).
  window.addEventListener('focus', () => {
    void refreshProjects();
    refreshInboxBadge();
  });
}

/**
 * Attention: poll the inbox on a slow interval + on focus, keep the sidebar
 * badge and the tab title (`(2) mdio`) in sync, and toast a newly-arrived
 * unhandled mention (click deep-links to the thread). Explicit non-goals for
 * now: web push, sounds, and per-thread read-state beyond the handled semantics.
 */
const MENTION_POLL_MS = 60_000;
/** Threads we've already surfaced (`project/doc#threadId`) — to toast only new ones. */
let knownMentions = new Set<string>();
let attentionPrimed = false;

function mentionKey(mention: api.InboxMention): string {
  return `${mention.project}/${mention.doc}#${mention.threadId}`;
}

/** The `?` keyboard-shortcuts cheat sheet — opened by `?`, closed by Escape/backdrop. */
function wireShortcutsDialog(): void {
  const overlay = document.querySelector('#shortcuts')! as HTMLElement;
  const close = () => {
    overlay.hidden = true;
  };
  document.querySelector('#shortcuts-close')!.addEventListener('click', close);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) {
      close();
      return;
    }
    // `?` opens it, unless the user is typing (input/textarea/CodeMirror/dialog).
    const target = event.target as HTMLElement;
    const typing =
      target.closest('input, textarea, [contenteditable="true"], .cm-editor') !== null ||
      !document.querySelector('#dialog')!.hasAttribute('hidden') ||
      !document.querySelector('#palette')!.hasAttribute('hidden');
    if (event.key === '?' && !typing) {
      event.preventDefault();
      overlay.hidden = false;
    }
  });
}

/** Sidebar Inbox badge = unhandled mentions + docs with pending suggestions. */
async function refreshInboxBadge(): Promise<void> {
  let inbox: api.Inbox;
  try {
    inbox = await api.getInbox(user.name);
  } catch {
    return;
  }
  const count = inbox.mentions.length + inbox.suggestions.reduce((sum, entry) => sum + entry.pending, 0);
  inboxBadgeEl.textContent = String(count);
  inboxBadgeEl.hidden = count === 0;
  document.title = count > 0 ? `(${count}) mdio` : 'mdio';

  // A mention we hadn't seen while the app was already open → nudge with a toast.
  // The first poll only primes the set (existing mentions aren't "new arrivals").
  const current = new Set(inbox.mentions.map(mentionKey));
  if (attentionPrimed) {
    for (const mention of inbox.mentions) {
      if (!knownMentions.has(mentionKey(mention))) {
        toast(`${mention.request.author} mentioned you in ${mention.doc}`, {
          onClick: () =>
            go(
              { kind: 'doc', project: mention.project, doc: `${mention.project}/${mention.doc}` },
              { doc: { comment: mention.threadId } },
            ),
        });
      }
    }
  }
  knownMentions = current;
  attentionPrimed = true;
}

/** Change the signed-in name live: persist it and re-join every awareness room. */
function changeName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
  user = withColors(name);
  renderMe();
  current?.provider.awareness.setLocalStateField('user', user);
  if (current) {
    registerAuthor(current.doc, { name: user.name, color: user.color, role: 'human' });
  }
}

/** Change the cursor color override live (null clears it back to hash-derived). */
function changeColor(color: string | null): void {
  if (color) {
    localStorage.setItem(COLOR_KEY, color);
  } else {
    localStorage.removeItem(COLOR_KEY);
  }
  user = withColors(user.name);
  renderMe();
  current?.provider.awareness.setLocalStateField('user', user);
}

function logoutNow(): void {
  localStorage.removeItem(NAME_KEY);
  location.reload();
}

async function init() {
  projects = await api.listProjects();
  await navigate();
  wireCrud();
  initPalette({
    projects: () => projects,
    currentProject: () => currentProject,
    go,
    newDocument: () => void newDocFlow(),
    newProject: () => void newProjectFlow(),
    connectAgent: () => void connectAgentFlow(),
    toggleMode: cycleMode,
    copyMcpConfig: () => void copyMcpConfig(),
  });
  void refreshInboxBadge();
  setInterval(() => void refreshInboxBadge(), MENTION_POLL_MS);
  // Back/forward and hand-edited URLs resolve the same way as the boot path.
  onUrlChange(() => void navigate());
}

async function main() {
  applyEditorPrefs();
  const name = storedUser() ?? (await promptForUser());
  user = withColors(name);
  appEl.hidden = false;
  renderMe();
  await init();
}

void main();
