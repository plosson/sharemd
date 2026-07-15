// The REST surface for project/document CRUD. Live editing happens over
// /ws/<project>/<doc-path>; everything lifecycle-shaped lives here:
//
//   GET    /api/projects                          list projects
//   POST   /api/projects            {name}        create a project
//   PATCH  /api/projects/:p         {name}        rename a project
//   DELETE /api/projects/:p                       delete a project (docs included)
//   GET    /api/projects/:p/mentions   ?who&open  open threads @mentioning a peer (all docs)
//   GET    /api/projects/:p/search     ?q&limit   full-text search across the project
//   GET    /api/projects/:p/mcp-config ?username  ready-to-paste MCP wiring for this project
//   GET    /api/projects/:p/docs                  list documents (project-relative)
//   POST   /api/projects/:p/docs    {path}        create an empty document
//   PATCH  /api/projects/:p/docs/*d {project?, path?}  rename / move a document
//   DELETE /api/projects/:p/docs/*d               delete a document
//   GET    /api/projects/:p/docs/*d/history       NDJSON update log
//   GET    /api/projects/:p/docs/*d/blame         per-line authorship
//   GET    /api/projects/:p/docs/*d/snapshots     list named versions
//   POST   /api/projects/:p/docs/*d/snapshots {label, author?}  save a version
//   POST   /api/projects/:p/docs/*d/snapshots/:id/restore {author?}  restore a version
//
// Errors are JSON {error} with 400 (invalid), 404 (missing), 409 (conflict).
import * as Y from 'yjs';
import { blameLines, TEXT_KEY } from '../shared/blame';
import { listThreads } from '../shared/comments';
import { parseUsername } from '../mcp/identity';
import { ConflictError, NotFoundError, type StoredSnapshot, type Vault } from './vault';
import { publicOrigin } from './cli-routes';
import type { RoomRegistry } from './rooms';

export function apiError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : 400;
  return Response.json({ error: message }, { status });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new Error('Request body must be JSON.');
  }
}

/** Like body(), but tolerates an empty/absent body (returns {}) — for optional fields. */
async function bodyOptional(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

let snapshotSeq = 0;

function newSnapshotId(): string {
  return `s-${Date.now().toString(36)}-${(++snapshotSeq).toString(36)}`;
}

/** Blame role from a username: owner-scoped ("plosson/claude") is an agent, "disk" is system. */
function roleOf(author: string): 'human' | 'agent' | 'system' {
  if (author === 'disk') {
    return 'system';
  }
  return author.includes('/') ? 'agent' : 'human';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`"${field}" must be a non-empty string.`);
  }
  return value;
}

/** A project-relative document path: plain forward-slash segments, nothing clever. */
function requireRelPath(value: unknown, field: string): string {
  const path = requireString(value, field);
  if (path.includes('\\') || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`"${field}" must be a relative document path like "notes/plan.md".`);
  }
  return path;
}

function methodNotAllowed(): Response {
  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

interface MentionEntry {
  /** Project-relative document path the thread lives in. */
  doc: string;
  threadId: string;
  quotedText: string;
  /** Current anchored text, or null when the commented range was deleted (orphaned). */
  currentText: string | null;
  resolved: boolean;
  /** The comment (root or reply) that named the peer — the actual request. */
  request: { author: string; body: string; createdAt: number };
  /** True once the peer has authored any comment in the thread. */
  respondedByWho: boolean;
}

/**
 * Read a document's Y.Doc without side effects: the live room if one is already
 * open (freshest), otherwise a throwaway doc rebuilt from the state sidecar.
 * `release()` disposes the throwaway; it is a no-op for a live room.
 */
async function docForRead(
  name: string,
  vault: Vault,
  registry: RoomRegistry,
): Promise<{ doc: Y.Doc | null; release: () => void }> {
  const open = await registry.peek(name)?.catch(() => null);
  if (open) {
    return { doc: open.doc, release: () => {} };
  }
  const state = await vault.readState(name);
  if (!state) {
    return { doc: null, release: () => {} };
  }
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, state);
  return { doc, release: () => doc.destroy() };
}

/**
 * Scan every document in a project for comment threads that @mention `who`.
 * A thread is "handled" once it is resolved or the peer has replied in it;
 * handled threads are omitted unless `includeHandled`.
 */
async function collectMentions(
  vault: Vault,
  registry: RoomRegistry,
  project: string,
  who: string,
  includeHandled: boolean,
): Promise<MentionEntry[]> {
  const docs = await vault.listDocs(project);
  const entries: MentionEntry[] = [];
  for (const rel of docs) {
    const { doc, release } = await docForRead(`${project}/${rel}`, vault, registry);
    if (!doc) {
      continue;
    }
    try {
      const content = doc.getText(TEXT_KEY).toString();
      for (const thread of listThreads(doc)) {
        const comments = [thread.root, ...thread.replies];
        const request = comments.find((comment) => comment.mentions.includes(who));
        if (!request) {
          continue;
        }
        const respondedByWho = comments.some((comment) => comment.author === who);
        if ((thread.resolved || respondedByWho) && !includeHandled) {
          continue;
        }
        entries.push({
          doc: rel,
          threadId: thread.root.id,
          quotedText: thread.quotedText,
          currentText: thread.range ? content.slice(thread.range.from, thread.range.to) : null,
          resolved: thread.resolved,
          request: { author: request.author, body: request.body, createdAt: request.createdAt },
          respondedByWho,
        });
      }
    } finally {
      release();
    }
  }
  return entries.sort((a, b) => a.request.createdAt - b.request.createdAt);
}

interface SearchMatch {
  /** Project-relative document path. */
  doc: string;
  line: number;
  column: number;
  snippet: string;
}

const SNIPPET_PAD = 30;

/** A trimmed window of `line` around the match, elided on either side when clipped. */
function makeSnippet(line: string, col: number, len: number): string {
  const start = Math.max(0, col - SNIPPET_PAD);
  const end = Math.min(line.length, col + len + SNIPPET_PAD);
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

/**
 * Case-insensitive substring search across a project's documents. Reads the live
 * room for open documents (freshest) and the markdown file for the rest (the
 * canonical source of truth — unsaved keystrokes in an unopened doc can't exist).
 * One match per line; stops at `maxResults`.
 */
async function searchProject(
  vault: Vault,
  registry: RoomRegistry,
  project: string,
  query: string,
  maxResults: number,
): Promise<SearchMatch[]> {
  const needle = query.toLowerCase();
  const docs = await vault.listDocs(project);
  const matches: SearchMatch[] = [];
  for (const rel of docs) {
    const name = `${project}/${rel}`;
    const open = await registry.peek(name)?.catch(() => null);
    const content = open ? open.doc.getText(TEXT_KEY).toString() : (await vault.read(name)) ?? '';
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const col = lines[i]!.toLowerCase().indexOf(needle);
      if (col >= 0) {
        matches.push({ doc: rel, line: i + 1, column: col + 1, snippet: makeSnippet(lines[i]!, col, query.length) });
        if (matches.length >= maxResults) {
          return matches;
        }
      }
    }
  }
  return matches;
}

/** Metadata view of a snapshot — the heavy `state` blob is never sent to clients. */
function snapshotMeta({ state: _state, ...meta }: StoredSnapshot): Omit<StoredSnapshot, 'state'> {
  return meta;
}

/**
 * Named versions of a document: list, capture (full CRDT state), and restore.
 * Restore converges the live text forward as an authored edit (see
 * Room.restoreContent) rather than resetting CRDT state under live peers.
 */
async function handleSnapshots(
  req: Request,
  vault: Vault,
  registry: RoomRegistry,
  project: string,
  relPath: string,
  docPath: string,
  snapshotId: string | null,
): Promise<Response> {
  if (snapshotId) {
    if (req.method !== 'POST') {
      return methodNotAllowed();
    }
    const snapshot = (await vault.readSnapshots(docPath)).find((entry) => entry.id === snapshotId);
    if (!snapshot) {
      throw new NotFoundError(`Snapshot "${snapshotId}" does not exist.`);
    }
    const raw = (await bodyOptional(req)).author;
    const author = typeof raw === 'string' && raw ? raw : 'disk';
    const restoreDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(restoreDoc, Buffer.from(snapshot.state, 'base64'));
    const content = restoreDoc.getText(TEXT_KEY).toString();
    restoreDoc.destroy();
    const room = await registry.open(docPath);
    const changed = room.restoreContent(content, { name: author, role: roleOf(author) });
    return Response.json({ id: snapshot.id, label: snapshot.label, restoredChars: content.length, changed });
  }

  switch (req.method) {
    case 'GET':
      return Response.json({
        project,
        path: relPath,
        snapshots: (await vault.readSnapshots(docPath)).map(snapshotMeta),
      });
    case 'POST': {
      const payload = await body(req);
      const label = requireString(payload.label, 'label');
      const author = typeof payload.author === 'string' ? payload.author : '';
      const room = await registry.open(docPath);
      await room.flush(); // capture what is actually persisted, not a mid-debounce state
      const snapshots = await vault.readSnapshots(docPath);
      const snapshot: StoredSnapshot = {
        id: newSnapshotId(),
        label,
        author,
        ts: Date.now(),
        state: Buffer.from(room.snapshotState()).toString('base64'),
      };
      snapshots.push(snapshot);
      await vault.writeSnapshots(docPath, snapshots);
      return Response.json(snapshotMeta(snapshot), { status: 201 });
    }
    default:
      return methodNotAllowed();
  }
}

/**
 * Route a /api/projects request. Returns null when the URL is not part of
 * this API space; throws vault errors for apiError() to map.
 */
export async function handleProjectsApi(
  req: Request,
  url: URL,
  vault: Vault,
  registry: RoomRegistry,
): Promise<Response | null> {
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'api' || segments[1] !== 'projects') {
    return null;
  }

  // /api/projects
  if (segments.length === 2) {
    switch (req.method) {
      case 'GET':
        return Response.json({ projects: await vault.listProjects() });
      case 'POST': {
        const name = requireString((await body(req)).name, 'name');
        await vault.createProject(name);
        return Response.json({ name }, { status: 201 });
      }
      default:
        return methodNotAllowed();
    }
  }

  const project = segments[2]!;

  // /api/projects/:p
  if (segments.length === 3) {
    switch (req.method) {
      case 'PATCH': {
        const name = requireString((await body(req)).name, 'name');
        if (name !== project) {
          await registry.releaseProject(project, { flush: true });
          await vault.renameProject(project, name);
        }
        return Response.json({ name });
      }
      case 'DELETE':
        await registry.releaseProject(project, { flush: false });
        await vault.deleteProject(project);
        return new Response(null, { status: 204 });
      default:
        return methodNotAllowed();
    }
  }

  // /api/projects/:p/mentions?who=<name>&open=<bool> — cross-document work queue:
  // open comment threads across every document in the project that @mention a peer.
  if (segments[3] === 'mentions' && segments.length === 4) {
    if (req.method !== 'GET') {
      return methodNotAllowed();
    }
    const who = requireString(url.searchParams.get('who'), 'who');
    const includeHandled = url.searchParams.get('open') === 'false';
    const mentions = await collectMentions(vault, registry, project, who, includeHandled);
    return Response.json({ project, who, mentions });
  }

  // /api/projects/:p/search?q=<text>&limit=<n> — full text across the project.
  if (segments[3] === 'search' && segments.length === 4) {
    if (req.method !== 'GET') {
      return methodNotAllowed();
    }
    const query = requireString(url.searchParams.get('q'), 'q');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const matches = await searchProject(vault, registry, project, query, limit);
    return Response.json({ project, query, matches });
  }

  // /api/projects/:p/mcp-config?username=<owner/agent> — everything needed to
  // wire an MCP peer to this project, rendered with the caller-visible origin
  // (reverse-proxy aware, like /install.sh).
  if (segments[3] === 'mcp-config' && segments.length === 4) {
    if (req.method !== 'GET') {
      return methodNotAllowed();
    }
    if (!(await vault.listProjects()).includes(project)) {
      throw new NotFoundError(`Project "${project}" does not exist.`);
    }
    const username = url.searchParams.get('username') || 'you/agent';
    parseUsername(username); // same validation the MCP applies at startup → 400
    const server = publicOrigin(req, url);
    return Response.json({
      project,
      server,
      username,
      install: `curl -fsSL ${server}/install.sh | sh`,
      configure: `mdio mcp install --server ${server} --username ${username} --project ${project} && mdio skill install`,
      mcpServers: {
        mdio: {
          command: 'mdio',
          args: ['mcp'],
          env: { MDIO_SERVER: server, MDIO_USERNAME: username, MDIO_PROJECT: project },
        },
      },
    });
  }

  if (segments[3] !== 'docs') {
    return null;
  }

  // /api/projects/:p/docs
  if (segments.length === 4) {
    switch (req.method) {
      case 'GET':
        return Response.json({ docs: await vault.listDocs(project) });
      case 'POST': {
        const path = requireRelPath((await body(req)).path, 'path');
        await vault.createDoc(`${project}/${path}`);
        return Response.json({ path }, { status: 201 });
      }
      default:
        return methodNotAllowed();
    }
  }

  // /api/projects/:p/docs/*d[/history|/blame|/snapshots[/:id/restore]] — trailing
  // action segments are unambiguous because document paths always end in a file
  // extension, so no doc path can end in "history"/"blame"/"snapshots"/"restore".
  let rest = segments.slice(4);
  let action: 'history' | 'blame' | 'snapshots' | null = null;
  let snapshotId: string | null = null;
  const last = rest[rest.length - 1];
  if (last === 'history' || last === 'blame' || last === 'snapshots') {
    action = last;
    rest = rest.slice(0, -1);
  } else if (last === 'restore' && rest[rest.length - 3] === 'snapshots') {
    action = 'snapshots';
    snapshotId = rest[rest.length - 2]!;
    rest = rest.slice(0, -3);
  }
  const relPath = rest.join('/');
  const docPath = `${project}/${relPath}`;

  if (action === 'history' || action === 'blame') {
    if (req.method !== 'GET') {
      return methodNotAllowed();
    }
    const room = await registry.open(docPath);
    if (action === 'history') {
      await room.flushLog();
      return new Response(await vault.readLog(docPath), {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      });
    }
    return Response.json({ project, path: relPath, lines: blameLines(room.doc) });
  }

  if (action === 'snapshots') {
    return handleSnapshots(req, vault, registry, project, relPath, docPath, snapshotId);
  }

  switch (req.method) {
    case 'PATCH': {
      const patch = await body(req);
      const toProject = patch.project === undefined ? project : requireString(patch.project, 'project');
      const toRel = patch.path === undefined ? relPath : requireRelPath(patch.path, 'path');
      const target = `${toProject}/${toRel}`;
      if (target !== docPath) {
        await registry.release(docPath, { flush: true });
        await vault.moveDoc(docPath, target);
      }
      return Response.json({ project: toProject, path: toRel });
    }
    case 'DELETE':
      await registry.release(docPath, { flush: false });
      await vault.deleteDoc(docPath);
      return new Response(null, { status: 204 });
    default:
      return methodNotAllowed();
  }
}
