# Changelog

All notable changes to mdio are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project has no tagged
releases yet, so entries are grouped by milestone date. Semantic version
headers start with the first tagged release.

## Unreleased

### Changed
- **UX rework, phase 3 — make the agent loop visible.** Acting on agent work,
  seeing it, moving fast, and getting pulled back when needed.
  - **Inline suggestion popovers** — clicking a suggestion mark (or ghost insert
    widget) opens an anchored popover at the text with the author, kind, −old/+new
    preview, and Accept / Reject / Withdraw, positioned via `view.coordsAtPos`
    (scroll-into-view + measure so it works in long documents). The right rail
    becomes explicit bulk review ("Review N suggestions") with Accept all / Reject
    all behind a danger confirm; Accept all re-resolves ranges between applications
    (anchor order, skipping orphans) and reports the outcome in a toast. The known
    concurrent double-accept trade-off is documented in code.
  - **Agent activity feed** — a per-project, **ephemeral** in-memory ring buffer
    (`src/server/activity.ts`, ~500 events, resets on restart, never persisted)
    exposed at `GET /api/projects/:p/activity`. Events come from signals already
    flowing through a room — join/leave, composing↔idle (writing/finished),
    suggestions (suggested/accepted/rejected), comments (commented/replied/resolved),
    and version saves/restores — via observers wired in `Room.open` that die with
    the room; events with no resolvable actor are dropped. Rendered as an Activity
    block on the Agents page and a compact last-3 strip on Home project cards.
  - **⌘K command palette** (`src/client/palette.ts`) — a keyboard-first overlay
    (⌘K/Ctrl+K, or the sidebar Search item) that jumps to any document across
    projects, full-text-searches the current project (≥3 chars, "In text"), and
    runs actions (New document / project, Connect an agent, Settings, Toggle mode,
    Copy MCP config). It replaces the per-project sidebar search input.
  - **Attention** — the inbox polls on a 60s interval and on focus, keeping the
    sidebar badge and the tab title (`(2) mdio`) in sync; a newly-arrived unhandled
    @mention pops a clickable toast that deep-links to the thread. (Non-goals for
    now: web push, sounds, per-thread read state.)
  - **Polish** — History and Versions merged into one two-tab drawer (single
    `History & versions` ⋯-menu entry); a composing agent's presence avatar pulses;
    empty-inbox teaching copy; a `?` keyboard-shortcuts dialog.
- **UX rework, phase 2 — Home, Inbox, Agents, and Settings surfaces.** The
  app grew from one document surface into five, behind a small plain-DOM router
  (no framework). `url-state` now resolves the path to a `view` discriminator
  (`home | project | doc | agents | settings`); the hash still carries doc-view
  state. The sidebar became global chrome: a wordmark + ⚙ settings link, Home
  and Inbox items (Inbox shows a live badge), and a per-project section
  (switcher, Agents item, doc list) shown only inside a project.
  - **Home (`/`)** — greeting with live counts (`N projects · M documents ·
    K agents connected`), a grid of project cards (doc count, last edit,
    present-peer faces) plus ghost cards (new project / connect an agent), the
    inbox block, recents across projects, and a first-run welcome when the vault
    is empty. Creating the first project optionally seeds a plain `welcome.md`.
    `/` no longer teleports into the first document.
  - **Inbox** — part of Home's URL space (no sixth route): unhandled @mentions
    and per-document pending-suggestion tallies aggregated across every project,
    with a *show handled* toggle; rows deep-link to the document with the thread
    focused. The sidebar badge refreshes on focus and after actions.
  - **Agents (`/<project>/agents`)** — a Tailscale-style connect flow replacing
    the MCP-config modal: the install one-liner, an editable identity whose
    `mdio mcp install` command and raw `.mcp.json` re-render live, and a
    ~3s peers poll that flips the status to "connected" (with a toast) when the
    chosen identity joins, above a connected-agents list.
  - **Settings (`/settings`)** — identity (live rename that re-joins awareness,
    a cursor-color override honored by `withColors`), editor preferences
    (default view mode, prose/monospace font, 68/72/80ch reading width —
    persisted in localStorage and applied), server & CLI info, and project
    management (rename/delete), plus logout.
- **UX rework, phase 1 — hierarchy & trust in the document view.** The
  single document surface got real hierarchy and a coat of paint, all
  client-side (no new routes or server APIs). Design tokens (CSS custom
  properties for ink/paper/accent/human/danger) now back every color.
  - **Header** replaces the row of seven identical pills with three zones:
    a breadcrumb `<project> / <title>` (title derived live from the doc's
    first heading, raw path in the tooltip) with a demoted connection status
    *dot*; an overlapping presence avatar stack (round for humans, squared in
    the accent color for agents, name in the tooltip); an `Edit | Both | Read`
    segmented mode toggle; and a `⋯` menu holding comment / history / versions
    / rename / move / delete (delete is red, behind the menu).
  - **View mode** — the URL hash now carries `mode=edit|both|read` (replacing
    the boolean `preview=1`; no back-compat). Read mode renders the preview
    full-width with the editor hidden.
  - **Prose ergonomics** — editor and preview cap at a 72ch centered column,
    render prose in a proportional font (fenced code stays monospaced),
    dim markdown syntax marks and enlarge headings via a CodeMirror
    `HighlightStyle`, and drop the line-number gutter.
  - **In-app dialogs & toasts** — a new `dialogs.ts` (`askText`, `askChoice`,
    `askConfirm`, `toast`) replaces every native `prompt`/`confirm`/`alert`
    in the client. Move-doc is now a project picker; errors surface as toasts,
    successes as brief confirmations.
  - **Project bar** — labeled `＋ new` button plus a `⋯` project menu
    (rename, connect an agent, delete); the MCP dialog's clipped command line
    now wraps.
  - **Empty states & login** — centered CTAs for an empty project (create a
    document / connect an agent) and an empty vault (create your first
    project); the login modal gained the wordmark and product context and
    renders over the app background instead of a ghosted editor.
  - **Trust fixes** — the project list refetches on window focus and after
    mutations; the versions dialog toasts on restore and disables save while
    a save is in flight.

### Added
- **Surface APIs (phase 2).** `GET /api/projects/:p/docs` now returns
  `{path, title, modified}` per document (title = first heading, modified =
  mtime) — breaking for the old `string[]` shape; the MCP `list_documents`
  still hands agents plain relative paths. `GET /api/mentions?who=` aggregates
  open @mentions and per-doc pending-suggestion counts across every project
  (Inbox + badge). `GET /api/projects/:p/peers` lists the peers in a project's
  already-open rooms (`RoomRegistry.openRooms()` enumerates settled rooms only,
  never opening one). `POST …/docs` accepts an optional `content` seed. All new
  endpoints are read-only and create nothing.
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
