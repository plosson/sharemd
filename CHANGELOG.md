# Changelog

All notable changes to mdio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project has no tagged
releases yet, so entries are grouped by milestone date. Semantic version
headers start with the first tagged release.

## Unreleased

### Added
- **Per-project MCP config** — `GET /api/projects/:p/mcp-config?username=`
  returns everything needed to wire an agent into a project (binary install
  one-liner, `mdio mcp install … --project` command, and the ready-to-paste
  `.mcp.json` entry), rendered with the caller-visible server URL
  (reverse-proxy aware). The web UI's 🤖 button in the project bar shows it
  with copy buttons, suggesting `<you>/claude` as the agent identity.

## 2026-07-15 — Agent collaboration suite (PR #9)

### Added
- **`list_mentions`** — a cross-document work queue for agents:
  `GET /api/projects/:p/mentions?who=` scans every document in a project
  (live room when open, otherwise the state sidecar — never opening or
  creating a room) for open comment threads that @mention a peer. A thread
  drops out of the queue once it is resolved or the peer has replied. The
  MCP tool of the same name lets an agent ask "where am I needed?" without
  opening a single document.
- **Named document versions** — `GET/POST …/docs/*d/snapshots` and
  `POST …/snapshots/:id/restore`, stored in a `.snapshots.json` sidecar that
  follows document renames/moves and dies with the document. Restore
  converges the live text back through a minimal authored splice — it lands
  in blame and history and is itself reversible; live peers just see the
  text change. Web UI: a "versions" panel to save and restore checkpoints.
- **Live activity presence** — while an agent holds a `begin_edit` session,
  its awareness state carries `composing` plus the nearest markdown heading;
  the web UI shows a "🖊 X is writing in §Section" banner until the session
  commits or aborts.
- **Project-wide search** — `GET /api/projects/:p/search?q=` (case-insensitive,
  one hit per line, with line/column and a snippet), a `search_project` MCP
  tool, and a debounced search box in the sidebar that opens the clicked hit.
- **Suggesting mode** — agents propose edits instead of making them:
  `suggest_insert` / `suggest_replace` / `suggest_delete` create anchored
  proposals in a new `suggestions` Y.Map (shared contract, like comments);
  humans see ghost-text/strikethrough decorations inline plus an
  accept/reject panel. Accepted text is blamed to the accepting human
  (deliberate: they take responsibility); `list_suggestions` and
  `withdraw_suggestion` close the loop for the agent. Suggestions anchor
  with relative positions, survive concurrent edits, and orphan gracefully
  when their target text is deleted.

### Fixed
- Snapshot restore no longer re-attributes blame of text it did not touch.
  Restores previously registered the restorer under the room doc's own
  clientID — shared with the hydrate-time "disk" reconcile — retroactively
  flipping everything that ID had ever written; successive restores by
  different users overwrote each other. Restores now splice through a
  scratch doc with its own clientID.

## 2026-07-13 — Projects & human-owned CRUD (PRs #7–#8)

### Added
- **Projects**: every document lives inside a top-level vault directory —
  room name, vault-relative path, and web URL `/<project>/<doc-path>` are
  the same string. Project names cannot shadow server routes.
- **Stable path URLs**: documents are addressed by real paths (SPA fallback
  server-side, `pushState` client-side); ephemeral view state (preview,
  comment focus, filters) lives in the URL hash.
- **REST CRUD API** under `/api/projects` — create/rename/delete projects,
  create/rename/move/delete documents (sidecars follow), plus per-document
  `history` and `blame` sub-resources. JSON `{error}` bodies with
  400/404/409 semantics.
- **Web UI CRUD**: project switcher with new/rename/delete, "new document",
  and per-document rename/move/delete in the header.
- **MCP project scoping**: a peer is fenced into one project
  (`MDIO_PROJECT`, required); all tool paths are project-relative.
  `mdio mcp install` gained `--project` (default `main`).
- One-shot migration moves pre-projects root documents (and their `.mdio/`
  sidecars) into `main/`.

### Changed
- **Breaking:** rooms exist only for documents already on disk — connecting
  never creates one. Document/project lifecycle is explicit REST, done by
  humans in the web UI; the MCP is deliberately edit-only (`open_document`
  refuses missing paths). Humans own the document set, agents work inside it.
- **Breaking:** `/api/docs`, `/api/history/*`, `/api/blame/*` were replaced
  by the `/api/projects` space; legacy `#doc=` / `?doc=` links were removed.
- Deleting a document discards its pending debounced persist (a straggling
  write can never resurrect the file) and force-disconnects its peers;
  rename/move flushes first, then relocates file + sidecars.

## 2026-07-13 — Rename, distribution, and deployment

### Changed
- **Breaking:** project renamed **sharemd → mdio**: `MDIO_*` env vars,
  `.mdio/` sidecar directory (auto-migrated from `.sharemd` on first open),
  `mdio` binary. `mcp install` absorbs a pre-rename `sharemd` entry in
  `.mcp.json`.

### Added
- **`mdio` client CLI** compiled to standalone per-platform binaries:
  `mdio mcp` (the stdio MCP), `mcp install`, `skill install`, `update`.
- **Self-distribution**: the server ships its own client —
  `curl -fsSL <server>/install.sh | sh`, `/api/cli` manifest/version/binary
  routes, reverse-proxy-aware installer templating.
- Dockerfile for containerized deployment; clean boot on an empty vault.
- CI: test workflow, tag-driven binary releases, and the
  mdio.houlahop.com landing page deploy.

## 2026-07-12 → 13 — Collaboration foundations

### Added
- **CRDT-native line blame**: persistent per-line authorship computed from
  the Y.Doc itself (`gc: false` keeps deleted items), surviving restarts
  via the state sidecar; offline disk edits are reconciled as a minimal
  "disk"-authored splice.
- **Comment threads** (Google-Docs-style): anchored with relative positions,
  orphan-surviving, with @mentions and a `mentioning` filter; full comment
  tool surface over MCP.
- **Per-document edit history**: append-only NDJSON update log with a web
  replay slider (scrub/play, author-colored flashes).
- **Live markdown preview** with mermaid diagrams.
- **Identity convention**: `owner/agent` usernames mark agent peers acting
  for a human; plain names are humans. Web login (localStorage) rejects `/`.
- Transient author-attributed highlights on remote edits.
- Navigation state in the URL.

## 2026-07-10 — Initial release

### Added
- Collaborative markdown server: Bun HTTP + WebSocket speaking the standard
  y-websocket protocol, one Yjs room per vault file, hydrating from disk
  and persisting back debounced. The markdown file stays the source of
  truth; the server is the sole writer of vault files.
- CodeMirror 6 web UI with presence and remote cursors.
- Stdio MCP server letting AI agents join documents as first-class CRDT
  peers: named presence, visible cursor, anchored edits (relative
  positions), stepwise writing (`begin_edit` / `append_text` /
  `commit_edit` / `abort_edit`), and one-shot `replace_text`.
