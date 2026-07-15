/**
 * ⌘K command palette: a keyboard-first overlay to jump to any document, search
 * text in the current project, or run an action. It absorbs the old per-project
 * sidebar search box. Sources are ranked: documents across all projects (title
 * + path, fetched once per open and cached), then full-text hits in the current
 * project (queries ≥3 chars, debounced), then actions.
 */

import * as api from './api';
import { el } from './ui';
import type { View } from './url-state';

/** The app-shell hooks the palette drives — provided by main.ts. */
export interface PaletteDeps {
  projects: () => string[];
  currentProject: () => string | null;
  go: (view: View, opts?: { push?: boolean }) => void;
  newDocument: () => void;
  newProject: () => void;
  connectAgent: () => void;
  toggleMode: () => void;
  copyMcpConfig: () => void;
}

interface PaletteItem {
  label: string;
  sub?: string;
  hint?: string;
  run: () => void;
}

interface Section {
  title: string;
  items: PaletteItem[];
}

interface DocEntry {
  project: string;
  /** Full vault path (`project/rel`). */
  path: string;
  /** Project-relative path. */
  rel: string;
  title: string | null;
}

const SEARCH_DEBOUNCE_MS = 200;
const MIN_TEXT_QUERY = 3;

const overlay = document.querySelector('#palette')! as HTMLElement;
const input = document.querySelector('#palette-input')! as HTMLInputElement;
const resultsEl = document.querySelector('#palette-results')! as HTMLElement;

let deps: PaletteDeps | null = null;
let open = false;
let selected = 0;
let flat: PaletteItem[] = [];

/** Documents across all projects, fetched lazily on open and cached per session. */
let docsCache: DocEntry[] | null = null;
/** Latest text-search result, keyed by the query it answers (stale ones ignored). */
let textResults: { query: string; matches: api.SearchMatch[] } | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function docLabel(entry: DocEntry): string {
  return entry.title ?? entry.rel.slice(entry.rel.lastIndexOf('/') + 1);
}

/** Case-insensitive substring rank: -1 for no match, else the match position. */
function rank(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle);
}

async function loadDocs(): Promise<void> {
  const projects = deps!.projects();
  const lists = await Promise.all(
    projects.map(async (project) => {
      const docs = await api.listDocs(project).catch(() => [] as api.DocMeta[]);
      return docs.map((doc) => ({ project, path: `${project}/${doc.path}`, rel: doc.path, title: doc.title }));
    }),
  );
  docsCache = lists.flat();
  render();
}

function documentSection(query: string): Section | null {
  if (!docsCache) {
    return null;
  }
  const needle = query.toLowerCase();
  const scored = docsCache
    .map((entry) => ({ entry, score: query ? Math.min(...matchScores(entry, needle)) : 0 }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => a.score - b.score || docLabel(a.entry).localeCompare(docLabel(b.entry)))
    .slice(0, query ? 20 : 8);
  if (scored.length === 0) {
    return null;
  }
  return {
    title: 'Documents',
    items: scored.map(({ entry }) => ({
      label: docLabel(entry),
      sub: entry.path,
      run: () => deps!.go({ kind: 'doc', project: entry.project, doc: entry.path }),
    })),
  };
}

/** Ranks for the fields we match a document on; -1 filtered out by the caller. */
function matchScores(entry: DocEntry, needle: string): number[] {
  const scores = [rank(docLabel(entry), needle), rank(entry.path, needle)].filter((score) => score >= 0);
  return scores.length ? scores : [-1];
}

function textSection(query: string): Section | null {
  const project = deps!.currentProject();
  if (!project || query.length < MIN_TEXT_QUERY || textResults?.query !== query) {
    return null;
  }
  if (textResults.matches.length === 0) {
    return null;
  }
  return {
    title: `In text · ${project}`,
    items: textResults.matches.slice(0, 12).map((match) => ({
      label: match.snippet,
      sub: `${match.doc}:${match.line}`,
      run: () => deps!.go({ kind: 'doc', project, doc: `${project}/${match.doc}` }),
    })),
  };
}

function actionSection(query: string): Section | null {
  const project = deps!.currentProject();
  const all: PaletteItem[] = [
    { label: 'New document', run: () => deps!.newDocument() },
    { label: 'New project', run: () => deps!.newProject() },
    { label: 'Connect an agent', run: () => deps!.connectAgent() },
    { label: 'Settings', run: () => deps!.go({ kind: 'settings' }) },
  ];
  if (project) {
    all.push(
      { label: 'Toggle mode (Edit / Both / Read)', run: () => deps!.toggleMode() },
      { label: 'Copy MCP config', run: () => deps!.copyMcpConfig() },
    );
  }
  const needle = query.toLowerCase();
  const items = query ? all.filter((item) => rank(item.label, needle) >= 0) : all;
  return items.length ? { title: 'Actions', items } : null;
}

function render(): void {
  const query = input.value.trim();
  const sections = [documentSection(query), textSection(query), actionSection(query)].filter(
    (section): section is Section => section !== null,
  );
  flat = sections.flatMap((section) => section.items);
  if (selected >= flat.length) {
    selected = Math.max(0, flat.length - 1);
  }

  resultsEl.replaceChildren();
  if (flat.length === 0) {
    resultsEl.append(el('div', { class: 'palette-empty', text: 'No matches.' }));
    return;
  }
  let index = 0;
  for (const section of sections) {
    resultsEl.append(el('div', { class: 'palette-section', text: section.title }));
    for (const item of section.items) {
      const at = index;
      const row = el(
        'div',
        {
          class: at === selected ? 'palette-item selected' : 'palette-item',
          dataset: { index: String(at) },
          onClick: () => runAt(at),
        },
        el(
          'div',
          { class: 'palette-item-main' },
          el('span', { class: 'palette-item-label', text: item.label }),
          item.sub ? el('span', { class: 'palette-item-sub', text: item.sub }) : null,
        ),
        item.hint ? el('span', { class: 'palette-item-hint', text: item.hint }) : null,
      );
      row.addEventListener('mousemove', () => {
        if (selected !== at) {
          selected = at;
          highlight();
        }
      });
      resultsEl.append(row);
      index += 1;
    }
  }
  highlight();
}

/** Update just the selected-row styling and scroll it into view (no rebuild). */
function highlight(): void {
  for (const row of resultsEl.querySelectorAll('.palette-item')) {
    const at = Number((row as HTMLElement).dataset.index);
    row.classList.toggle('selected', at === selected);
    if (at === selected) {
      (row as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }
}

function runAt(index: number): void {
  const item = flat[index];
  if (!item) {
    return;
  }
  closePalette();
  item.run();
}

function scheduleTextSearch(): void {
  const query = input.value.trim();
  const project = deps!.currentProject();
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
  if (!project || query.length < MIN_TEXT_QUERY) {
    textResults = null;
    return;
  }
  searchTimer = setTimeout(() => {
    void api
      .searchProject(project, query)
      .then((matches) => {
        textResults = { query, matches };
        if (open && input.value.trim() === query) {
          render();
        }
      })
      .catch(() => {});
  }, SEARCH_DEBOUNCE_MS);
}

export function openPalette(): void {
  if (!deps || open) {
    return;
  }
  open = true;
  selected = 0;
  docsCache = null; // refetch each session so new documents appear
  textResults = null;
  input.value = '';
  overlay.hidden = false;
  input.focus();
  render();
  void loadDocs();
}

export function closePalette(): void {
  open = false;
  overlay.hidden = true;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
}

/** Wire the palette once at boot: ⌘K/Ctrl+K, overlay chrome, keyboard nav. */
export function initPalette(hooks: PaletteDeps): void {
  deps = hooks;

  input.addEventListener('input', () => {
    selected = 0;
    scheduleTextSearch();
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (flat.length) {
        selected = (selected + 1) % flat.length;
        highlight();
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length) {
        selected = (selected - 1 + flat.length) % flat.length;
        highlight();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runAt(selected);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      closePalette();
    }
  });

  // ⌘K / Ctrl+K toggles the palette from anywhere in the app.
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      if (open) {
        closePalette();
      } else {
        openPalette();
      }
    }
  });
}
