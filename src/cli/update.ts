import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json';
import { readMcpConfig } from './mcp-install';

/** True when running as a compiled `sharemd` binary (Bun.main is a bunfs path). */
export function isCompiledBinary(): boolean {
  return Bun.main.includes('$bunfs') || Bun.main.includes('~BUN');
}

/**
 * Self-update, KCLI-style: re-fetch the server's own install script and run it
 * in update mode (SHAREMD_UPDATE=1). The script version-checks against
 * /api/cli/version and atomically replaces this binary in place — keeping the
 * update logic server-side instead of frozen into old binaries.
 */
export async function runUpdate(serverFlag?: string): Promise<void> {
  if (!isCompiledBinary()) {
    throw new Error('sharemd update only works on an installed binary — in a checkout, git pull instead.');
  }
  const server =
    serverFlag ?? process.env.SHAREMD_SERVER ?? (await readMcpConfig())?.SHAREMD_SERVER;
  if (!server) {
    throw new Error(
      'No server to update from — pass --server <url>, set SHAREMD_SERVER, or run from a project with .mcp.json.',
    );
  }
  const base = server.replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://');
  const isWindows = process.platform === 'win32';
  const scriptUrl = `${base}/install.${isWindows ? 'ps1' : 'sh'}`;
  const response = await fetch(scriptUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch ${scriptUrl}: HTTP ${response.status}`);
  }
  const scriptPath = join(tmpdir(), `sharemd-update-${process.pid}.${isWindows ? 'ps1' : 'sh'}`);
  await Bun.write(scriptPath, await response.text());
  try {
    const child = Bun.spawn(
      isWindows ? ['powershell', '-ExecutionPolicy', 'Bypass', '-File', scriptPath] : ['sh', scriptPath],
      {
        env: {
          ...process.env,
          SHAREMD_UPDATE: '1',
          SHAREMD_CURRENT_BIN: process.execPath,
          SHAREMD_CURRENT_VERSION: pkg.version,
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const code = await child.exited;
    if (code !== 0) {
      process.exit(code);
    }
  } finally {
    await rm(scriptPath, { force: true });
  }
}
