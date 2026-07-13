import { join } from 'node:path';
import { parseUsername } from '../mcp/identity';

export interface McpInstallOptions {
  server: string;
  username: string;
  /** Command written into .mcp.json; defaults to the bare binary name. */
  command?: string;
  cwd?: string;
}

export interface McpInstallResult {
  path: string;
  action: 'created' | 'updated';
  entry: McpServerEntry;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpJson {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Write (or merge into) the project's `.mcp.json`, setting only the `sharemd`
 * entry and preserving everything else — other servers, unknown top-level keys,
 * and any extra fields a host put on our entry are kept untouched.
 */
export async function installMcpConfig(options: McpInstallOptions): Promise<McpInstallResult> {
  parseUsername(options.username); // same validation the MCP applies at startup
  const server = options.server.replace(/\/+$/, '');
  if (!/^(https?|wss?):\/\//.test(server)) {
    throw new Error(`--server must be an http(s) or ws(s) URL, got "${options.server}"`);
  }

  const path = join(options.cwd ?? process.cwd(), '.mcp.json');
  const file = Bun.file(path);
  let config: McpJson = {};
  const exists = await file.exists();
  if (exists) {
    try {
      config = JSON.parse(await file.text()) as McpJson;
    } catch {
      throw new Error(`${path} exists but is not valid JSON — fix or remove it first.`);
    }
  }

  const servers = (config.mcpServers ??= {}) as Record<string, unknown>;
  const previous = (servers.sharemd ?? {}) as Record<string, unknown>;
  const entry: McpServerEntry = {
    command: options.command ?? 'sharemd',
    args: ['mcp'],
    env: {
      ...((previous.env as Record<string, string>) ?? {}),
      SHAREMD_SERVER: server,
      SHAREMD_USERNAME: options.username,
    },
  };
  servers.sharemd = { ...previous, ...entry };

  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, action: exists ? 'updated' : 'created', entry };
}

/** Read the sharemd env from a `.mcp.json`, if present (used as an update fallback). */
export async function readMcpConfig(cwd = process.cwd()): Promise<Record<string, string> | null> {
  const file = Bun.file(join(cwd, '.mcp.json'));
  if (!(await file.exists())) {
    return null;
  }
  try {
    const config = JSON.parse(await file.text()) as McpJson;
    const entry = (config.mcpServers as Record<string, { env?: Record<string, string> }> | undefined)?.sharemd;
    return entry?.env ?? null;
  } catch {
    return null;
  }
}
