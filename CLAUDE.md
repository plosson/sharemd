# sharemd

Collaborative markdown over Yjs: a Bun server that turns a folder of markdown files into
live collaborative documents, a CodeMirror web UI for humans, and a stdio MCP server that
lets AI agents join the same documents as first-class CRDT peers (named presence, visible
cursor, anchored edits).

## Commands

- `bun run start [vaultDir] [--port N]` — serve a vault (default `./vault`, port 4321)
- `bun test` — server + MCP tests (fast, no browser)
- `bun run test:e2e` — Playwright e2e: two MCP agents + a browser editing concurrently
- `bun run test:all` — everything
- `bun run mcp` — the stdio MCP entrypoint (normally launched by an MCP host, not by hand)

Tests are self-contained: each spawns its own server on an ephemeral port with a temp vault.

## Architecture

- `src/server/` — Bun HTTP + WebSocket server speaking the standard y-websocket wire
  protocol (`/ws/<vault-relative-path>`, one Yjs room per file). Rooms hydrate from disk
  and persist back debounced (400ms). `vault.ts` guards path traversal and file types.
- `src/client/` — web UI, bundled by `Bun.build` at server startup (no build step).
  CodeMirror 6 + `y-codemirror.next` for remote cursors; `remote-edits.ts` flashes
  transient author-attributed highlights on remote inserts.
- `src/mcp/` — stdio MCP (`@modelcontextprotocol/sdk`). `runtime.ts` is the editing
  runtime: search matches and the cursor are stored as **Yjs relative positions** so they
  survive concurrent edits (exact-text re-find as fallback). Stepwise writing via
  `begin_edit` / `append_text` / `commit_edit` / `abort_edit`.
- `tests/` — `helpers.ts` (test server + raw Yjs peers), `mcp-client.ts` (scripted MCP
  host over real stdio), plus server/MCP/e2e suites.

## Invariants

- The Y.Doc text key is `content`; the authorship map key is `authors` (clientID →
  identity, see `src/shared/blame.ts`); the room name is the vault-relative file path. All
  are shared contracts between server, client, and MCP — change them everywhere or nowhere.
- Docs that compute blame (server rooms, MCP sessions) are created with `gc: false` so
  deleted items survive for snapshot diffs; peers must register in the `authors` map on
  connect, before their first edit.
- The server is the **sole writer** of vault files. There is deliberately no file watcher:
  external disk edits while the server runs are unsupported (decision, not an oversight).
  The markdown file stays the source of truth for content; `.sharemd/<path>.yjs` sidecars
  only add history, and any divergence is reconciled as a "disk"-authored edit on hydrate.
- Editing tools must anchor with relative positions, never raw character offsets held
  across await points — other peers edit between tool calls.
- Peer identity comes from the MCP config env (`SHAREMD_USERNAME`, optional
  `SHAREMD_AGENT_COLOR`, `SHAREMD_SERVER`), not from tool arguments. Convention (trust,
  not auth): `owner/agent` (e.g. `plosson/claude`) means role `agent` linked to that human;
  a plain name means role `human` — so an MCP peer can act as a human. The web UI asks for
  a username (localStorage, logout clears it) and rejects `/` in it.
- The MCP process must keep stdout clean (protocol channel) — diagnostics go to stderr.

## MCP config for an agent

```json
{
  "mcpServers": {
    "sharemd": {
      "command": "bun",
      "args": ["run", "<repo>/src/mcp/index.ts"],
      "env": {
        "SHAREMD_SERVER": "http://localhost:4321",
        "SHAREMD_USERNAME": "plosson/claude"
      }
    }
  }
}
```
