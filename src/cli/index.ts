#!/usr/bin/env bun
// The `sharemd` client CLI. Its editing surface IS the MCP (`sharemd mcp` runs
// the stdio server; the MCP host keeps the process alive); the other
// subcommands are one-shot lifecycle helpers: wiring .mcp.json, installing the
// bundled Claude skill, and self-updating against a sharemd server.
import { parseArgs } from 'node:util';
import pkg from '../../package.json';
import { runMcp } from '../mcp/index';
import { installMcpConfig } from './mcp-install';
import { installSkill, type InstallScope } from './skill-install';
import { runUpdate } from './update';

const USAGE = `sharemd ${pkg.version} — collaborative markdown client (MCP + installers)

Usage:
  sharemd mcp                      Run the stdio MCP server (what an MCP host launches)
  sharemd mcp install [options]    Add/refresh the sharemd entry in ./.mcp.json
      --server <url>               sharemd server URL (default: $SHAREMD_SERVER)
      --username <name>            "you" (human) or "you/agent" (default: $SHAREMD_USERNAME)
      --command <cmd>              command written to .mcp.json (default: sharemd)
  sharemd skill install [--user]   Install the Claude skill to <cwd>/.claude/skills/sharemd/
                                   (--user installs to ~/.claude/skills/sharemd/ instead)
  sharemd update [--server <url>]  Update this binary from the server's install script
  sharemd version                  Print the version

Get the binary from a running server:  curl -fsSL <server>/install.sh | sh
`;

function fail(message: string): never {
  console.error(`sharemd: ${message}`);
  process.exit(1);
}

async function mcpInstallCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: 'string' },
      username: { type: 'string' },
      command: { type: 'string' },
    },
  });
  const server = values.server ?? process.env.SHAREMD_SERVER;
  const username = values.username ?? process.env.SHAREMD_USERNAME;
  if (!server) {
    fail('mcp install needs --server <url> (or SHAREMD_SERVER set).');
  }
  if (!username) {
    fail('mcp install needs --username <name> (or SHAREMD_USERNAME set) — "you" or "you/agent".');
  }
  const result = await installMcpConfig({ server, username, command: values.command });
  console.log(`${result.action === 'created' ? 'Created' : 'Updated'} ${result.path}`);
  console.log(`  sharemd → ${result.entry.command} mcp  (server ${result.entry.env.SHAREMD_SERVER}, user ${result.entry.env.SHAREMD_USERNAME})`);
  if (result.entry.command === 'sharemd' && !Bun.which('sharemd')) {
    console.error('warning: "sharemd" is not on your PATH — MCP hosts will fail to launch it.');
    console.error('         Install it first: curl -fsSL <server>/install.sh | sh');
  }
}

async function skillInstallCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { user: { type: 'boolean' }, project: { type: 'boolean' } },
  });
  const scope: InstallScope = values.user ? 'user' : 'project';
  const result = await installSkill(scope);
  console.log(
    result.action === 'unchanged'
      ? `Skill already up to date at ${result.path}`
      : `${result.action === 'created' ? 'Installed' : 'Updated'} skill at ${result.path}`,
  );
}

async function updateCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { server: { type: 'string' } } });
  await runUpdate(values.server);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'mcp':
        if (rest[0] === 'install') {
          await mcpInstallCommand(rest.slice(1));
        } else if (rest.length === 0) {
          await runMcp(); // stdio protocol from here on — nothing else may touch stdout
        } else {
          fail(`unknown mcp subcommand "${rest[0]}" — try "sharemd mcp" or "sharemd mcp install".`);
        }
        return;
      case 'skill':
        if (rest[0] === 'install') {
          await skillInstallCommand(rest.slice(1));
        } else {
          fail(`unknown skill subcommand "${rest[0] ?? ''}" — try "sharemd skill install".`);
        }
        return;
      case 'update':
        await updateCommand(rest);
        return;
      case 'version':
      case '--version':
      case '-v':
        console.log(pkg.version);
        return;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return;
      default:
        fail(`unknown command "${command}" — run "sharemd help".`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
