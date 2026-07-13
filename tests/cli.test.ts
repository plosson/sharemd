import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, DEMO_CONTENT } from './helpers';
import { AgentClient } from './mcp-client';
import type { MdioServer } from '../src/server/index';
import { installSkill, skillInstallPath } from '../src/cli/skill-install';
import { installMcpConfig, readMcpConfig } from '../src/cli/mcp-install';
import { CLI_PLATFORMS, cliPlatform } from '../src/cli/platforms';
import pkg from '../package.json';

const PROJECT_ROOT = join(import.meta.dir, '..');

/**
 * Async spawn (unlike Bun.spawnSync, which would block the event loop and
 * deadlock any child talking to the in-process test server).
 */
async function run(
  cmd: string[],
  env?: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { env: env as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** The CLI_PLATFORMS id of the machine running the tests (what install.sh will detect). */
function currentPlatformId(): string {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${os}-${arch}`;
}

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mdio-cli-test-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('skill install', () => {
  test('creates the skill, then reports unchanged on rerun', async () => {
    const cwd = join(tmp, 'skill-project');
    const first = await installSkill('project', cwd);
    expect(first.action).toBe('created');
    expect(first.path).toBe(join(cwd, '.claude', 'skills', 'mdio', 'SKILL.md'));
    const content = await Bun.file(first.path).text();
    expect(content).toStartWith('---\nname: mdio\n');
    expect(content).toContain('Never touch vault files on disk');

    const second = await installSkill('project', cwd);
    expect(second.action).toBe('unchanged');
  });

  test('user scope targets the home directory', () => {
    expect(skillInstallPath('user', '/proj', '/home/someone')).toBe(
      '/home/someone/.claude/skills/mdio/SKILL.md',
    );
  });
});

describe('mcp install', () => {
  test('creates .mcp.json with the mdio entry', async () => {
    const cwd = join(tmp, 'mcp-fresh');
    await Bun.write(join(cwd, '.keep'), '');
    const result = await installMcpConfig({
      server: 'http://localhost:9999/',
      username: 'plosson/claude',
      cwd,
    });
    expect(result.action).toBe('created');
    const config = JSON.parse(await Bun.file(result.path).text());
    expect(config.mcpServers.mdio).toEqual({
      command: 'mdio',
      args: ['mcp'],
      env: { MDIO_SERVER: 'http://localhost:9999', MDIO_USERNAME: 'plosson/claude' },
    });
  });

  test('merges without clobbering other servers, unknown keys, or extra env', async () => {
    const cwd = join(tmp, 'mcp-merge');
    await Bun.write(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        someTopLevel: true,
        mcpServers: {
          other: { command: 'other-tool', args: [] },
          mdio: { command: 'bun', args: ['old'], env: { MDIO_AGENT_COLOR: '#123456' } },
        },
      }),
    );
    const result = await installMcpConfig({ server: 'ws://md.example.com', username: 'plosson', cwd });
    expect(result.action).toBe('updated');
    const config = JSON.parse(await Bun.file(result.path).text());
    expect(config.someTopLevel).toBe(true);
    expect(config.mcpServers.other).toEqual({ command: 'other-tool', args: [] });
    expect(config.mcpServers.mdio.command).toBe('mdio');
    expect(config.mcpServers.mdio.args).toEqual(['mcp']);
    // extra env survives, server URL is normalized, username replaced
    expect(config.mcpServers.mdio.env).toEqual({
      MDIO_AGENT_COLOR: '#123456',
      MDIO_SERVER: 'ws://md.example.com',
      MDIO_USERNAME: 'plosson',
    });
    expect(await readMcpConfig(cwd)).toEqual(config.mcpServers.mdio.env);
  });

  test('rejects invalid usernames and non-URL servers', async () => {
    const cwd = join(tmp, 'mcp-invalid');
    expect(installMcpConfig({ server: 'http://x', username: 'a/b/c', cwd })).rejects.toThrow('at most one');
    expect(installMcpConfig({ server: 'not-a-url', username: 'plosson', cwd })).rejects.toThrow('http(s)');
  });

  test('refuses to overwrite an unparseable .mcp.json', async () => {
    const cwd = join(tmp, 'mcp-broken');
    await Bun.write(join(cwd, '.mcp.json'), '{ not json');
    expect(installMcpConfig({ server: 'http://x', username: 'plosson', cwd })).rejects.toThrow('not valid JSON');
  });
});

describe('cli process', () => {
  function runCli(args: string[], cwd = PROJECT_ROOT): { code: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(['bun', 'run', join(PROJECT_ROOT, 'src', 'cli', 'index.ts'), ...args], {
      cwd,
      env: { ...process.env, MDIO_SERVER: undefined, MDIO_USERNAME: undefined },
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test('version prints the package version', () => {
    const result = runCli(['version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test('help shows usage; unknown commands fail', () => {
    expect(runCli(['help']).stdout).toContain('mdio mcp install');
    const unknown = runCli(['frobnicate']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('unknown command');
  });

  test('mcp install without a server fails with guidance', () => {
    const result = runCli(['mcp', 'install']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--server');
  });
});

describe('distribution routes', () => {
  let server: MdioServer;
  let distDir: string;
  const previousDist = process.env.MDIO_CLI_DIST;

  beforeAll(async () => {
    distDir = join(tmp, 'dist-cli');
    process.env.MDIO_CLI_DIST = distDir;
    ({ server } = await startTestServer());
  });

  afterAll(async () => {
    if (previousDist === undefined) {
      delete process.env.MDIO_CLI_DIST;
    } else {
      process.env.MDIO_CLI_DIST = previousDist;
    }
    await server.stop();
  });

  test('/api/cli/version reports the package version', async () => {
    const response = await fetch(`${server.url}/api/cli/version`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(pkg.version);
  });

  test('/api/cli lists every registry platform with availability', async () => {
    const { version, platforms } = (await (await fetch(`${server.url}/api/cli`)).json()) as {
      version: string;
      platforms: Array<{ id: string; available: boolean }>;
    };
    expect(version).toBe(pkg.version);
    expect(platforms.map((platform) => platform.id).sort()).toEqual(
      [...CLI_PLATFORMS.map((platform) => platform.id)].sort(),
    );
    expect(platforms.every((platform) => platform.available === false)).toBe(true);
  });

  test('install.sh is templated with the caller-visible origin', async () => {
    const script = await (await fetch(`${server.url}/install.sh`)).text();
    expect(script).toContain(`BASE="${server.url}"`);
    expect(script).toContain('/api/cli/$target');
    for (const platform of CLI_PLATFORMS.filter((entry) => entry.os === 'unix')) {
      expect(script).toContain(platform.id);
    }

    const proxied = await (
      await fetch(`${server.url}/install.sh`, {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'md.example.com' },
      })
    ).text();
    expect(proxied).toContain('BASE="https://md.example.com"');
  });

  test('install.ps1 targets the shipped Windows platform', async () => {
    const script = await (await fetch(`${server.url}/install.ps1`)).text();
    expect(script).toContain("$target = 'windows-x64'");
  });

  test('binary download: 404 for unknown or unbundled, 200 with headers when bundled', async () => {
    expect((await fetch(`${server.url}/api/cli/amiga-68k`)).status).toBe(404);
    const platform = cliPlatform('linux-x64')!;
    expect((await fetch(`${server.url}/api/cli/${platform.id}`)).status).toBe(404);

    await Bun.write(join(distDir, platform.file), 'fake-binary-bytes');
    const response = await fetch(`${server.url}/api/cli/${platform.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('17');
    expect(response.headers.get('content-disposition')).toContain(`filename="${platform.saveAs}"`);
    expect(await response.text()).toBe('fake-binary-bytes');
  });
});

describe('compiled binary end-to-end', () => {
  let server: MdioServer;
  let distDir: string;
  let binPath: string;
  let installedBin: string;
  const previousDist = process.env.MDIO_CLI_DIST;

  beforeAll(async () => {
    distDir = join(tmp, 'dist-e2e');
    process.env.MDIO_CLI_DIST = distDir;
    ({ server } = await startTestServer());
  });

  afterAll(async () => {
    if (previousDist === undefined) {
      delete process.env.MDIO_CLI_DIST;
    } else {
      process.env.MDIO_CLI_DIST = previousDist;
    }
    await server.stop();
  });

  test(
    'compiles a native binary into the served dist dir',
    () => {
      const platform = cliPlatform(currentPlatformId());
      expect(platform).toBeDefined();
      binPath = join(distDir, platform!.file);
      const result = Bun.spawnSync(
        ['bun', 'build', 'src/cli/index.ts', '--compile', '--outfile', binPath],
        { cwd: PROJECT_ROOT },
      );
      expect(result.exitCode).toBe(0);
      const version = Bun.spawnSync([binPath, 'version']);
      expect(version.stdout.toString().trim()).toBe(pkg.version);
    },
    120000,
  );

  test(
    'curl | sh flow: install.sh downloads and installs the binary',
    async () => {
      const home = join(tmp, 'install-home');
      const installDir = join(home, 'bin');
      const scriptPath = join(tmp, 'install.sh');
      await Bun.write(scriptPath, await (await fetch(`${server.url}/install.sh`)).text());
      const result = await run(['sh', scriptPath], {
        ...process.env,
        HOME: home,
        MDIO_INSTALL_DIR: installDir,
      });
      expect(result.code).toBe(0);
      installedBin = join(installDir, cliPlatform(currentPlatformId())!.saveAs);
      expect(result.stdout + result.stderr).toContain(`Installed ${cliPlatform(currentPlatformId())!.saveAs} to ${installedBin}`);
      const version = await run([installedBin, 'version']);
      expect(version.stdout.trim()).toBe(pkg.version);
    },
    30000,
  );

  test(
    'mdio update: the installed binary version-checks against the server',
    async () => {
      const result = await run([installedBin, 'update', '--server', server.url], {
        ...process.env,
        MDIO_SERVER: undefined,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('already up to date');
    },
    30000,
  );

  test(
    'mdio mcp: the binary is a full MCP peer (open, edit, read back)',
    async () => {
      const agent = await AgentClient.spawn(server.url, 'plosson/claude', {
        command: binPath,
        args: ['mcp'],
      });
      try {
        const tools = await agent.listTools();
        expect(tools).toContain('open_document');
        expect(tools).toContain('begin_edit');

        const { docs } = await agent.call<{ docs: string[] }>('list_documents');
        expect(docs).toContain('demo.md');

        await agent.call('open_document', { path: 'demo.md' });
        await agent.call('replace_text', { query: 'First note', replacement: 'First note (via binary)' });
        const { text } = await agent.call<{ text: string }>('read_document');
        expect(text).toContain('First note (via binary)');
        expect(text).toContain(DEMO_CONTENT.split('\n')[0]);
      } finally {
        await agent.close();
      }
    },
    30000,
  );
});
