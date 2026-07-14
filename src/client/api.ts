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

/** Documents of a project as project-relative paths. */
export async function listDocs(project: string): Promise<string[]> {
  return (await api<{ docs: string[] }>('GET', `/api/projects/${encodeURIComponent(project)}/docs`)).docs;
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
