// The REST surface for project/document CRUD. Live editing happens over
// /ws/<project>/<doc-path>; everything lifecycle-shaped lives here:
//
//   GET    /api/projects                          list projects
//   POST   /api/projects            {name}        create a project
//   PATCH  /api/projects/:p         {name}        rename a project
//   DELETE /api/projects/:p                       delete a project (docs included)
//   GET    /api/projects/:p/docs                  list documents (project-relative)
//   POST   /api/projects/:p/docs    {path}        create an empty document
//   PATCH  /api/projects/:p/docs/*d {project?, path?}  rename / move a document
//   DELETE /api/projects/:p/docs/*d               delete a document
//   GET    /api/projects/:p/docs/*d/history       NDJSON update log
//   GET    /api/projects/:p/docs/*d/blame         per-line authorship
//
// Errors are JSON {error} with 400 (invalid), 404 (missing), 409 (conflict).
import { blameLines } from '../shared/blame';
import { ConflictError, NotFoundError, type Vault } from './vault';
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

  // /api/projects/:p/docs/*d[/history|/blame] — the trailing action segment is
  // unambiguous because document paths always end in a file extension.
  let rest = segments.slice(4);
  let action: 'history' | 'blame' | null = null;
  const last = rest[rest.length - 1];
  if (last === 'history' || last === 'blame') {
    action = last;
    rest = rest.slice(0, -1);
  }
  const relPath = rest.join('/');
  const docPath = `${project}/${relPath}`;

  if (action) {
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
