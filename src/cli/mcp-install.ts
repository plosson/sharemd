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
 * Write (or merge into) the project's `.mcp.json`, setting only the `mdio`
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
  // A pre-rename `sharemd` entry is ours too: absorb it into `mdio`, dropping
  // the old env spellings it carried.
  const previous = (servers.mdio ?? servers.sharemd ?? {}) as Record<string, unknown>;
  const previousEnv = { ...((previous.env as Record<string, string>) ?? {}) };
  delete previousEnv.SHAREMD_SERVER;
  delete previousEnv.SHAREMD_USERNAME;
  const entry: McpServerEntry = {
    command: options.command ?? 'mdio',
    args: ['mcp'],
    env: {
      ...previousEnv,
      MDIO_SERVER: server,
      MDIO_USERNAME: options.username,
    },
  };
  servers.mdio = { ...previous, ...entry };
  delete servers.sharemd;

  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, action: exists ? 'updated' : 'created', entry };
}

/** Read the mdio env from a `.mcp.json`, if present (used as an update fallback). */
export async function readMcpConfig(cwd = process.cwd()): Promise<Record<string, string> | null> {
  const file = Bun.file(join(cwd, '.mcp.json'));
  if (!(await file.exists())) {
    return null;
  }
  try {
    const config = JSON.parse(await file.text()) as McpJson;
    const servers = config.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
    const env = (servers?.mdio ?? servers?.sharemd)?.env;
    if (!env) {
      return null;
    }
    // A pre-rename entry spells the server SHAREMD_SERVER — surface it as MDIO_SERVER.
    return env.MDIO_SERVER || !env.SHAREMD_SERVER ? env : { ...env, MDIO_SERVER: env.SHAREMD_SERVER };
  } catch {
    return null;
  }
}
