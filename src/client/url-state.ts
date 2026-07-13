/**
 * Navigation state: the document is the URL path (/project/notes/plan.md) and
 * a bare project page is /project, so links are stable, shareable paths. View
 * state stays in the hash as query-style params (#preview=1&comment=c-xyz).
 *
 * Document switches push a history entry (back/forward navigates documents);
 * view-state changes (preview, comment focus, filters) replace the current
 * entry so they survive reload and sharing without polluting history.
 * pushState/replaceState don't fire popstate, so only user navigation
 * (back/forward, hash edits) triggers the listener — no self-echo guard needed.
 */

export interface UrlState {
  doc: string | null;
  /** The doc's project (first path segment), or a doc-less project page. */
  project: string | null;
  preview: boolean;
  comment: string | null;
  resolved: boolean;
}

const DOC_EXTENSION = /\.(md|markdown|txt)$/i;

function decodePath(pathname: string): string | null {
  const raw = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!raw) {
    return null;
  }
  return raw.split('/').map(decodeURIComponent).join('/');
}

function encodePath(path: string): string {
  return `/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function readUrlState(): UrlState {
  const params = new URLSearchParams(location.hash.slice(1));
  // Pre-path-URL links carried the doc in the hash (#doc=…) — honour them
  // when the path itself names nothing; boot normalizes to the path form.
  const path = decodePath(location.pathname) ?? params.get('doc');
  const isDoc = path !== null && DOC_EXTENSION.test(path);
  return {
    doc: isDoc ? path : null,
    project: isDoc ? path!.split('/')[0]! : path,
    preview: params.get('preview') === '1',
    comment: params.get('comment'),
    resolved: params.get('resolved') === '1',
  };
}

export function writeUrlState(partial: Partial<UrlState>, { push = false } = {}): void {
  const current = readUrlState();
  const next = { ...current, ...partial };
  // A document names its project; only doc-less states keep an explicit one.
  if (partial.doc && partial.project === undefined) {
    next.project = partial.doc.split('/')[0]!;
  }
  const params = new URLSearchParams();
  if (next.preview) {
    params.set('preview', '1');
  }
  if (next.comment) {
    params.set('comment', next.comment);
  }
  if (next.resolved) {
    params.set('resolved', '1');
  }
  const serialized = params.toString();
  const path = next.doc ? encodePath(next.doc) : next.project ? encodePath(next.project) : '/';
  const url = `${path}${location.search}${serialized ? `#${serialized}` : ''}`;
  if (push) {
    history.pushState(null, '', url);
  } else {
    history.replaceState(null, '', url);
  }
}

export function onUrlChange(handler: (state: UrlState) => void): void {
  window.addEventListener('popstate', () => handler(readUrlState()));
}
