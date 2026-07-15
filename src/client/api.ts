/** Client bindings for the /api/projects REST space (see src/server/api.ts). */

function encodeSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** URL of a document resource, or of one of its sub-resources (history/blame/snapshots). */
export function docApiUrl(docPath: string, action?: 'history' | 'blame' | 'snapshots'): string {
  const [project, ...rest] = docPath.split('/');
  const base = `/api/projects/${encodeURIComponent(project!)}/docs/${encodeSegments(rest.join('/'))}`;
  return action ? `${base}/${action}` : base;
}

async function api<T = void>(method: string, url: string, payload?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) {
    const message = await response
      .json()
      .then((data) => (data as { error?: string }).error ?? null)
      .catch(() => null);
    throw new Error(message ?? `HTTP ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export async function listProjects(): Promise<string[]> {
  return (await api<{ projects: string[] }>('GET', '/api/projects')).projects;
}

export function createProject(name: string): Promise<{ name: string }> {
  return api('POST', '/api/projects', { name });
}

export function renameProject(from: string, to: string): Promise<{ name: string }> {
  return api('PATCH', `/api/projects/${encodeURIComponent(from)}`, { name: to });
}

export function deleteProject(name: string): Promise<void> {
  return api('DELETE', `/api/projects/${encodeURIComponent(name)}`);
}

/** A document with list metadata: project-relative path, first-heading title, mtime. */
export interface DocMeta {
  path: string;
  title: string | null;
  modified: number;
}

/** Documents of a project with metadata (title, mtime), project-relative paths. */
export async function listDocs(project: string): Promise<DocMeta[]> {
  return (await api<{ docs: DocMeta[] }>('GET', `/api/projects/${encodeURIComponent(project)}/docs`)).docs;
}

export function createDoc(project: string, path: string): Promise<{ path: string }> {
  return api('POST', `/api/projects/${encodeURIComponent(project)}/docs`, { path });
}

/** Rename within the project ({path}), move across projects ({project}), or both. */
export function moveDoc(
  docPath: string,
  target: { project?: string; path?: string },
): Promise<{ project: string; path: string }> {
  return api('PATCH', docApiUrl(docPath), target);
}

export function deleteDoc(docPath: string): Promise<void> {
  return api('DELETE', docApiUrl(docPath));
}

/** A full-text search hit within a project (doc path is project-relative). */
export interface SearchMatch {
  doc: string;
  line: number;
  column: number;
  snippet: string;
}

export async function searchProject(project: string, query: string): Promise<SearchMatch[]> {
  const url = `/api/projects/${encodeURIComponent(project)}/search?q=${encodeURIComponent(query)}`;
  return (await api<{ matches: SearchMatch[] }>('GET', url)).matches;
}

/** A named version of a document (metadata only; the CRDT state stays server-side). */
export interface Snapshot {
  id: string;
  label: string;
  author: string;
  ts: number;
}

export async function listSnapshots(docPath: string): Promise<Snapshot[]> {
  return (await api<{ snapshots: Snapshot[] }>('GET', docApiUrl(docPath, 'snapshots'))).snapshots;
}

export function createSnapshot(docPath: string, label: string, author: string): Promise<Snapshot> {
  return api('POST', docApiUrl(docPath, 'snapshots'), { label, author });
}

export function restoreSnapshot(
  docPath: string,
  snapshotId: string,
  author: string,
): Promise<{ id: string; label: string; restoredChars: number; changed: number }> {
  return api('POST', `${docApiUrl(docPath, 'snapshots')}/${encodeURIComponent(snapshotId)}/restore`, {
    author,
  });
}

/** Ready-to-paste MCP wiring for a project, rendered with the server's public origin. */
export interface McpConfig {
  project: string;
  server: string;
  username: string;
  install: string;
  configure: string;
  mcpServers: Record<string, unknown>;
}

export function getMcpConfig(project: string, username: string): Promise<McpConfig> {
  const url = `/api/projects/${encodeURIComponent(project)}/mcp-config?username=${encodeURIComponent(username)}`;
  return api('GET', url);
}

/** One open comment thread @mentioning a peer, located in a project/document. */
export interface InboxMention {
  project: string;
  doc: string;
  threadId: string;
  quotedText: string;
  currentText: string | null;
  resolved: boolean;
  request: { author: string; body: string; createdAt: number };
  respondedByWho: boolean;
}

/** Per-document tally of suggested edits awaiting review. */
export interface InboxSuggestions {
  project: string;
  doc: string;
  pending: number;
}

export interface Inbox {
  who: string;
  mentions: InboxMention[];
  suggestions: InboxSuggestions[];
}

/** The cross-project inbox for a peer (mentions + pending suggestions). */
export function getInbox(who: string, { includeHandled = false } = {}): Promise<Inbox> {
  const params = new URLSearchParams({ who });
  if (includeHandled) {
    params.set('open', 'false');
  }
  return api('GET', `/api/mentions?${params}`);
}

/** A peer connected to one of a project's open rooms. */
export interface ProjectPeer {
  name: string;
  role: 'human' | 'agent';
  color: string | null;
  /** Project-relative document the peer is in. */
  doc: string;
  status: string | null;
}

/** Peers connected to a project right now (reads only already-open rooms). */
export async function getPeers(project: string): Promise<ProjectPeer[]> {
  return (await api<{ peers: ProjectPeer[] }>('GET', `/api/projects/${encodeURIComponent(project)}/peers`)).peers;
}
