import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentRuntime } from './runtime';
import { resolveIdentity, resolveProject } from './identity';
import type { AgentIdentity } from './session';
import pkg from '../../package.json';

function identityFromEnv(): { identity: AgentIdentity; project: string } {
  try {
    return { identity: resolveIdentity(process.env), project: resolveProject(process.env) };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function resolveServerUrls(env: Record<string, string | undefined> = process.env): {
  wsBase: string;
  httpBase: string;
} {
  const raw = (env.MDIO_SERVER || 'http://localhost:4321').replace(/\/+$/, '');
  const httpBase = raw.replace(/^ws(s?):\/\//, 'http$1://');
  const wsBase = `${httpBase.replace(/^http(s?):\/\//, 'ws$1://')}/ws`;
  return { wsBase, httpBase };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function respond(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  return Promise.resolve()
    .then(fn)
    .then((result) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }) }],
    }))
    .catch((error: unknown) => ({
      content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    }));
}

/** Run the stdio MCP server until the transport closes (the process' whole life). */
export async function runMcp(): Promise<void> {
  const { identity, project } = identityFromEnv();
  const { wsBase, httpBase } = resolveServerUrls();
  const runtime = new AgentRuntime(wsBase, httpBase, identity, project);

  const server = new McpServer({ name: pkg.name, version: pkg.version });

  server.registerTool(
    'list_documents',
    {
      description:
        'List the markdown documents in your project (this MCP peer is scoped to one project of the shared workspace). Paths are project-relative.',
    },
    () => respond(async () => ({ project, docs: await runtime.listDocuments() })),
  );

  server.registerTool(
    'list_mentions',
    {
      description:
        'Your work queue: open comment threads across your whole project that @mention you. Unlike list_comments (the open document only), this scans every document without opening it, so you can find where you are needed. Each entry gives the document path, the requesting comment, and its anchored text. Act on one by open_document(that path) → make the edit → reply_comment + resolve_comment to close the loop. By default only unhandled threads (not resolved, no reply from you) are returned; pass includeHandled:true to see all.',
      inputSchema: { includeHandled: z.boolean().optional() },
    },
    ({ includeHandled }) => respond(() => runtime.listMentions({ includeHandled })),
  );

  server.registerTool(
    'search_project',
    {
      description:
        'Search the full text of every document in your project and get back the matching documents with line numbers and snippets — without opening anything. Use it to find the right document before open_document. Case-insensitive substring match, one hit per line. (search_text, by contrast, searches only the currently open document.)',
      inputSchema: {
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ query, maxResults }) => respond(() => runtime.searchProject(query, maxResults ?? 20)),
  );

  server.registerTool(
    'open_document',
    {
      description:
        'Open an existing document by project-relative path and join its live collaboration session. Other collaborators (humans and agents) may be editing it at the same time; all edits merge in realtime. Opens replace the previously open document. Creating, renaming, or deleting documents is reserved to humans (web UI) — agents only edit and comment.',
      inputSchema: { path: z.string().min(1) },
    },
    ({ path }) => respond(() => runtime.openDocument(path)),
  );

  server.registerTool(
    'read_document',
    {
      description:
        'Read the current live text of the open document (a window of up to maxChars). The document may change between calls as others edit, so re-read before deciding where to edit.',
      inputSchema: {
        startChar: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(100).max(20000).optional(),
      },
    },
    ({ startChar, maxChars }) => respond(() => runtime.readDocument(startChar ?? 0, maxChars ?? 6000)),
  );

  server.registerTool(
    'search_text',
    {
      description:
        'Find exact text in the open document — whitespace and newlines match literally, so trailing/blank-line text is anchorable. Returns stable match handles (matchIds) that stay anchored to the found text even while others edit concurrently. Use handles with place_cursor, replace_match, and delete_range.',
      inputSchema: {
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(20).optional(),
      },
    },
    ({ query, maxResults }) => respond(() => ({ matches: runtime.searchText(query, maxResults ?? 8) })),
  );

  server.registerTool(
    'blame_document',
    {
      description:
        'Per-line authorship of the open document, git-blame style: each line lists every author who wrote surviving characters on it (with char counts). Authorship comes from the CRDT itself, so it survives concurrent edits.',
      inputSchema: {
        startLine: z.number().int().min(1).optional(),
        maxLines: z.number().int().min(1).max(1000).optional(),
      },
    },
    ({ startLine, maxLines }) => respond(() => runtime.blameDocument(startLine ?? 1, maxLines ?? 200)),
  );

  server.registerTool(
    'place_cursor',
    {
      description:
        'Place your visible cursor at the start or end of a match (matchId + edge), or at the document boundary (boundary: "start" | "end"). Subsequent insert_text and begin_edit(mode: "insert") happen at the cursor.',
      inputSchema: {
        matchId: z.string().optional(),
        edge: z.enum(['start', 'end']).optional(),
        boundary: z.enum(['start', 'end']).optional(),
      },
    },
    (input) => respond(() => runtime.placeCursor(input)),
  );

  server.registerTool(
    'insert_text',
    {
      description:
        'Insert text at the current cursor as one atomic edit. Good for short, single-shot insertions. For writing longer content progressively, prefer begin_edit + append_text + commit_edit.',
      inputSchema: { text: z.string().min(1) },
    },
    ({ text }) => respond(() => runtime.insertText(text)),
  );

  server.registerTool(
    'replace_match',
    {
      description: 'Replace the exact text of a previously found match with new text.',
      inputSchema: { matchId: z.string().min(1), text: z.string() },
    },
    ({ matchId, text }) => respond(() => runtime.replaceMatch(matchId, text)),
  );

  server.registerTool(
    'replace_text',
    {
      description:
        'Find exact text and replace it in one call — no round-trip between search and replace, so nothing can move in between. The text must occur exactly once; if it is missing or ambiguous this fails and search_text + replace_match gives finer control. Whitespace and newlines match literally.',
      inputSchema: { query: z.string().min(1), replacement: z.string() },
    },
    ({ query, replacement }) => respond(() => runtime.replaceText(query, replacement)),
  );

  server.registerTool(
    'delete_range',
    {
      description:
        'Delete everything from the start of one match to the end of another (inclusive of both matches). Use search_text first to anchor both ends.',
      inputSchema: { startMatchId: z.string().min(1), endMatchId: z.string().min(1) },
    },
    ({ startMatchId, endMatchId }) => respond(() => runtime.deleteRange(startMatchId, endMatchId)),
  );

  server.registerTool(
    'add_comment',
    {
      description:
        'Attach a comment thread to a text range, anchored via a search_text match handle. The anchor follows the text under concurrent edits; if the text is later deleted the thread survives as "orphaned" with its original quote. Mention peers with @name or @owner/agent in the body.',
      inputSchema: { matchId: z.string().min(1), body: z.string().min(1) },
    },
    ({ matchId, body }) => respond(() => runtime.addComment(matchId, body)),
  );

  server.registerTool(
    'list_comments',
    {
      description:
        'List comment threads on the open document (root + replies, resolved state, quoted and current anchored text). Filter with includeResolved:false or mentioning:"name" (e.g. your own username to find comments addressed to you).',
      inputSchema: {
        includeResolved: z.boolean().optional(),
        mentioning: z.string().optional(),
      },
    },
    (input) => respond(() => runtime.listComments(input)),
  );

  server.registerTool(
    'reply_comment',
    {
      description: 'Reply to a comment thread (commentId must be the thread root).',
      inputSchema: { commentId: z.string().min(1), body: z.string().min(1) },
    },
    ({ commentId, body }) => respond(() => runtime.replyComment(commentId, body)),
  );

  server.registerTool(
    'edit_comment',
    {
      description: 'Edit the body of a comment you authored.',
      inputSchema: { commentId: z.string().min(1), body: z.string().min(1) },
    },
    ({ commentId, body }) => respond(() => runtime.editComment(commentId, body)),
  );

  server.registerTool(
    'resolve_comment',
    {
      description:
        'Resolve a comment thread (or reopen it with resolved:false). Anyone can resolve; commentId must be the thread root.',
      inputSchema: { commentId: z.string().min(1), resolved: z.boolean().optional() },
    },
    ({ commentId, resolved }) => respond(() => runtime.resolveComment(commentId, resolved ?? true)),
  );

  server.registerTool(
    'delete_comment',
    {
      description: 'Delete a comment you authored. Deleting a thread root deletes its replies too.',
      inputSchema: { commentId: z.string().min(1) },
    },
    ({ commentId }) => respond(() => runtime.deleteComment(commentId)),
  );

  server.registerTool(
    'suggest_insert',
    {
      description:
        'Propose inserting text (a suggested edit a human accepts or rejects) instead of writing it directly. Anchors at a match edge (matchId + edge) or, with no match, at your cursor. Use this when you want a human to review before your words land — otherwise just insert_text.',
      inputSchema: {
        text: z.string().min(1),
        matchId: z.string().optional(),
        edge: z.enum(['start', 'end']).optional(),
      },
    },
    ({ text, matchId, edge }) => respond(() => runtime.suggestInsert(text, { matchId, edge })),
  );

  server.registerTool(
    'suggest_replace',
    {
      description:
        'Propose replacing a matched range with new text, as a suggested edit for a human to accept or reject. Anchor the range first with search_text.',
      inputSchema: { matchId: z.string().min(1), text: z.string() },
    },
    ({ matchId, text }) => respond(() => runtime.suggestReplace(matchId, text)),
  );

  server.registerTool(
    'suggest_delete',
    {
      description:
        'Propose deleting everything from the start of one match to the end of another (inclusive), as a suggested edit for a human to accept or reject. Anchor both ends with search_text first.',
      inputSchema: { startMatchId: z.string().min(1), endMatchId: z.string().min(1) },
    },
    ({ startMatchId, endMatchId }) => respond(() => runtime.suggestDelete(startMatchId, endMatchId)),
  );

  server.registerTool(
    'list_suggestions',
    {
      description:
        'List suggested edits on the open document (kind, proposed text, quoted/current target text, status, who resolved it). Filter to unresolved with includeResolved:false. Accepting or rejecting is the human\'s call in the web UI; check status here to see what happened to yours.',
      inputSchema: { includeResolved: z.boolean().optional() },
    },
    (input) => respond(() => runtime.listSuggestions(input)),
  );

  server.registerTool(
    'withdraw_suggestion',
    {
      description: 'Withdraw a pending suggestion you authored (removes it entirely).',
      inputSchema: { suggestionId: z.string().min(1) },
    },
    ({ suggestionId }) => respond(() => runtime.withdrawSuggestion(suggestionId)),
  );

  server.registerTool(
    'begin_edit',
    {
      description:
        'Start a stepwise edit session: mode "insert" writes at the current cursor, mode "append" writes at the end of the document. Then call append_text one or more times (a paragraph or two per call, so humans see you writing progressively), and finish with commit_edit — or abort_edit to revert everything written in the session.',
      inputSchema: { mode: z.enum(['insert', 'append']) },
    },
    ({ mode }) => respond(() => runtime.beginEdit(mode)),
  );

  server.registerTool(
    'append_text',
    {
      description:
        'Append the next chunk of text to the active edit session. Keep chunks small (a paragraph or two) and call repeatedly — collaborators watch your progress live.',
      inputSchema: { text: z.string() },
    },
    ({ text }) => respond(() => runtime.appendText(text)),
  );

  server.registerTool(
    'commit_edit',
    { description: 'Finish the active edit session, keeping everything written.' },
    () => respond(() => runtime.commitEdit()),
  );

  server.registerTool(
    'abort_edit',
    { description: 'Cancel the active edit session and revert the text it wrote.' },
    () => respond(() => runtime.abortEdit()),
  );

  process.on('SIGINT', () => {
    runtime.destroy();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    runtime.destroy();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    runtime.destroy();
    process.exit(0);
  };
  await server.connect(transport);
  console.error(`mdio MCP ready — agent "${identity.name}" on project "${project}" targeting ${httpBase}`);
}

if (import.meta.main) {
  await runMcp();
}
