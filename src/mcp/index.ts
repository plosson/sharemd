import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentRuntime } from './runtime';
import type { AgentIdentity } from './session';

const PALETTE = ['#e05252', '#2f7fd1', '#1a9c74', '#c2571f', '#8a4bbf', '#c23b64'];

function resolveIdentity(): AgentIdentity {
  const name = process.env.SHAREMD_AGENT_NAME;
  if (!name) {
    console.error('SHAREMD_AGENT_NAME is required — set it in the MCP server config env.');
    process.exit(1);
  }
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  const color = process.env.SHAREMD_AGENT_COLOR || PALETTE[Math.abs(hash) % PALETTE.length]!;
  return { name, color, colorLight: `${color}33` };
}

function resolveServerUrls(): { wsBase: string; httpBase: string } {
  const raw = (process.env.SHAREMD_SERVER || 'http://localhost:4321').replace(/\/+$/, '');
  const httpBase = raw.replace(/^ws(s?):\/\//, 'http$1://');
  const wsBase = `${httpBase.replace(/^http(s?):\/\//, 'ws$1://')}/ws`;
  return { wsBase, httpBase };
}

const identity = resolveIdentity();
const { wsBase, httpBase } = resolveServerUrls();
const runtime = new AgentRuntime(wsBase, httpBase, identity);

const server = new McpServer({ name: 'sharemd', version: '0.1.0' });

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

server.registerTool(
  'list_documents',
  { description: 'List the markdown documents available in the shared workspace.' },
  () => respond(async () => ({ docs: await runtime.listDocuments() })),
);

server.registerTool(
  'open_document',
  {
    description:
      'Open a document by path and join its live collaboration session. Other collaborators (humans and agents) may be editing it at the same time; all edits merge in realtime. Opens replace the previously open document.',
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
      'Find exact text in the open document. Returns stable match handles (matchIds) that stay anchored to the found text even while others edit concurrently. Use handles with place_cursor, replace_match, and delete_range.',
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
  'delete_range',
  {
    description:
      'Delete everything from the start of one match to the end of another (inclusive of both matches). Use search_text first to anchor both ends.',
    inputSchema: { startMatchId: z.string().min(1), endMatchId: z.string().min(1) },
  },
  ({ startMatchId, endMatchId }) => respond(() => runtime.deleteRange(startMatchId, endMatchId)),
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
console.error(`sharemd MCP ready — agent "${identity.name}" targeting ${httpBase}`);
