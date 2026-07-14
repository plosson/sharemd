---
name: mdio
description: Collaborate on shared markdown documents through the mdio MCP tools (list_documents, open_document, search_text, begin_edit, comments). Use when reading, writing, reviewing, or commenting on documents in a shared mdio vault or workspace, when responding to @mentions or comment threads, or when asked who wrote something in a shared document.
---

# Collaborating on mdio documents

mdio documents are live collaborative markdown files backed by a CRDT. You join as a
named peer: humans in a browser see your name, cursor, and edits in real time — and they
may be editing at the same time. Edits merge automatically; there are no locks and no
conflicts, so never wait for or ask permission before editing.

You are scoped to **one project** of the vault (set by `MDIO_PROJECT` in the MCP config).
All document paths are relative to that project; documents in other projects are not
visible and cannot be opened. You cannot create, rename, or delete documents — that is
deliberately reserved to humans (web UI). If a document you need doesn't exist, say so
and ask a collaborator to create it; `list_documents` shows what exists.

## The one hard rule

**Never touch vault files on disk.** If a document lives in an mdio vault, do not use
file tools (Read/Edit/Write, `cat`, `sed`, …) on it — the mdio server is the sole
writer of vault files, there is no file watcher, and disk edits made while the server
runs are silently lost or diverge. Always go through the mdio MCP tools.

## Ground rules

- The document can change between any two tool calls. Never treat text you read earlier
  as ground truth — re-read or re-search just before acting.
- Never compute or reuse character offsets. Anchor everything with `search_text` match
  handles (matchIds); they stay attached to the intended text while others edit.
- You are visible. Write long content progressively (a paragraph or two per call), keep
  your cursor where you work, and prefer commenting over silently rewriting someone
  else's prose. While a `begin_edit` session is open, humans see a "writing in §Section"
  banner for you — so commit or abort promptly rather than holding a session open idle.
- Yield to humans. If someone is actively typing in the same region you were about to
  rewrite, prefer a comment over a competing edit, or work elsewhere and come back —
  this is courtesy, not a lock (there are none).
- One document open at a time (`open_document` replaces the previous one) and one
  stepwise edit session at a time.

## Workflows

### Orient
1. `list_documents` to see what exists; `search_project(query)` to find which document
   contains something (full-text across the whole project, with line numbers — no need to
   open each one). Then `open_document(path)`.
2. `read_document` returns a window (default 6000 chars). For long documents, page with
   `startChar` until `endChar == charCount`.
3. `blame_document` shows per-line authorship when you need to know who wrote what.
`search_project` searches every document; `search_text` searches only the open one.

### Small targeted change
- Preferred: `replace_text(query, replacement)` — one shot, no race window. The query
  must occur exactly once; whitespace and newlines match literally.
- If it fails as ambiguous: extend the query with surrounding context, or use
  `search_text(query)` → pick the right matchId from the before/after previews →
  `replace_match(matchId, text)`.

### Insert at a specific spot
1. `search_text` for a stable landmark near the target (e.g. the heading above it).
2. `place_cursor(matchId, edge)` — or `boundary: "start" | "end"` for document edges.
3. `insert_text` for short one-shots; a stepwise edit session for anything longer.

### Write longer content (sections, drafts)
1. `begin_edit(mode: "append")` — or `"insert"` to write at the cursor.
2. `append_text` repeatedly, a paragraph or two per call, so collaborators watch you
   write instead of seeing a wall of text appear.
3. `commit_edit` when done; `abort_edit` reverts everything written in the session.
Atomic tools (`insert_text`, `replace_*`, `delete_range`) are blocked while a session is
active — commit or abort first.

### Delete a section
`search_text` the first and the last line of the section, then
`delete_range(startMatchId, endMatchId)` — inclusive of both matches.

### Review a document
1. `read_document` plus `blame_document` for authorship.
2. Anchor feedback on the exact text: `search_text` → `add_comment(matchId, body)`.
   Mention peers with `@name` or `@owner/agent` in the body.
3. Comment first; edit someone else's prose only when asked to.

### Propose edits for review (suggesting mode)
When a human wants to approve your wording before it lands, propose instead of writing:
1. `search_text` to anchor, then `suggest_replace(matchId, text)`,
   `suggest_delete(startMatchId, endMatchId)`, or `suggest_insert(text, matchId?, edge?)`.
   The text does not change — the human sees your proposal inline and accepts or rejects it.
2. `list_suggestions(includeResolved: true)` shows what happened to yours (status +
   who resolved it); `withdraw_suggestion(id)` retracts one you no longer want.
Accepting/rejecting is the human's call (web UI) — you propose, they decide. For edits
you're trusted to make directly, use the normal edit tools instead.

### Respond to feedback addressed to you
1. `list_mentions` is your work queue: it finds every open thread across the **whole
   project** that @mentions you — no document need be open. (Within one open document,
   `list_comments(mentioning: "<your username>", includeResolved: false)` is the local
   view.) By default it returns only unhandled threads (not resolved, no reply from you);
   pass `includeHandled: true` to see everything.
2. For each entry: `open_document(entry.doc)`, then make the requested change (workflows
   above), anchoring on `entry.currentText` (or `entry.quotedText` if it was deleted).
3. `reply_comment` explaining what you did, then `resolve_comment` — that drops the
   thread out of `list_mentions`, so the queue empties as you work.
Orphaned threads (their anchored text was deleted) keep the original quote — use it to
understand what the comment referred to.

## Pitfalls

- matchIds live in your MCP session and are consumed by `replace_match` /
  `delete_range`. If a matchId is unknown or stale, re-run `search_text` — don't guess.
- `replace_text` failing on 0 or >1 occurrences is a feature: disambiguate by extending
  the query, never by shortening it.
- "Match no longer exists" means someone edited that text away — re-read before retrying.
- Your identity (name, `owner/agent` role) and project scope come from the MCP server
  config env, not from tool arguments; you cannot act as someone else or reach outside
  your project.
