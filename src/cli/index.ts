#!/usr/bin/env bun
// The `mdio` client CLI. Its editing surface IS the MCP (`mdio mcp` runs
// the stdio server; the MCP host keeps the process alive); the other
// subcommands are one-shot lifecycle helpers: wiring .mcp.json, installing the
// bundled Claude skill, and self-updating against an mdio server.
import { parseArgs } from 'node:util';
import pkg from '../../package.json';
import { runMcp } from '../mcp/index';
import { installMcpConfig } from './mcp-install';
import { installSkill, type InstallScope } from './skill-install';
import { runUpdate } from './update';

const USAGE = `${pkg.name} ${pkg.version} — collaborative markdown client (MCP + installers)

Usage:
  mdio mcp                      Run the stdio MCP server (what an MCP host launches)
  mdio mcp install [options]    Add/refresh the mdio entry in ./.mcp.json
      --server <url>            mdio server URL (default: $MDIO_SERVER)
      --username <name>         "you" (human) or "you/agent" (default: $MDIO_USERNAME)
      --command <cmd>           command written to .mcp.json (default: mdio)
  mdio skill install [--user]   Install the Claude skill to <cwd>/.claude/skills/mdio/
                                (--user installs to ~/.claude/skills/mdio/ instead)
  mdio update [--server <url>]  Update this binary from the server's install script
  mdio version                  Print the version

Get the binary from a running server:  curl -fsSL <server>/install.sh | sh
`;

function fail(message: string): never {
  console.error(`mdio: ${message}`);
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
  const server = values.server ?? process.env.MDIO_SERVER;
  const username = values.username ?? process.env.MDIO_USERNAME;
  if (!server) {
    fail('mcp install needs --server <url> (or MDIO_SERVER set).');
  }
  if (!username) {
    fail('mcp install needs --username <name> (or MDIO_USERNAME set) — "you" or "you/agent".');
  }
  const result = await installMcpConfig({ server, username, command: values.command });
  console.log(`${result.action === 'created' ? 'Created' : 'Updated'} ${result.path}`);
  console.log(`  mdio → ${result.entry.command} mcp  (server ${result.entry.env.MDIO_SERVER}, user ${result.entry.env.MDIO_USERNAME})`);
  if (result.entry.command === 'mdio' && !Bun.which('mdio')) {
    console.error('warning: "mdio" is not on your PATH — MCP hosts will fail to launch it.');
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
          fail(`unknown mcp subcommand "${rest[0]}" — try "mdio mcp" or "mdio mcp install".`);
        }
        return;
      case 'skill':
        if (rest[0] === 'install') {
          await skillInstallCommand(rest.slice(1));
        } else {
          fail(`unknown skill subcommand "${rest[0] ?? ''}" — try "mdio skill install".`);
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
        fail(`unknown command "${command}" — run "mdio help".`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
