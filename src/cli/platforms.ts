import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * A platform we ship a standalone `sharemd` binary for. Single source of truth
 * for the build (`scripts/build-cli.ts` compiles `bunTarget` → `file`), the
 * download API (`GET /api/cli/{id}` streams `file`), and the server-rendered
 * install scripts. Kept small on purpose; add an entry to ship another.
 */
export interface CliPlatform {
  /** URL segment / stable id, e.g. `darwin-arm64`. */
  id: string;
  /** Human label. */
  label: string;
  /** `bun build --compile --target` value (build-time only). */
  bunTarget: string;
  /** Compiled filename under the CLI dist dir. */
  file: string;
  /** Shell family the install one-liner is written for. */
  os: 'unix' | 'windows';
  /** Suggested local filename when downloading. */
  saveAs: string;
}

export const CLI_PLATFORMS: readonly CliPlatform[] = [
  {
    id: 'linux-x64',
    label: 'Linux (x64)',
    bunTarget: 'bun-linux-x64',
    file: 'sharemd-linux-x64',
    os: 'unix',
    saveAs: 'sharemd',
  },
  {
    id: 'darwin-arm64',
    label: 'macOS (Apple Silicon)',
    bunTarget: 'bun-darwin-arm64',
    file: 'sharemd-darwin-arm64',
    os: 'unix',
    saveAs: 'sharemd',
  },
  {
    id: 'windows-x64',
    label: 'Windows (x64)',
    bunTarget: 'bun-windows-x64',
    file: 'sharemd-windows-x64.exe',
    os: 'windows',
    saveAs: 'sharemd.exe',
  },
];

export function cliPlatform(id: string): CliPlatform | undefined {
  return CLI_PLATFORMS.find((platform) => platform.id === id);
}

/** Where compiled binaries live; SHAREMD_CLI_DIST overrides (tests, deploys). */
export function cliDistDir(): string {
  return (
    process.env.SHAREMD_CLI_DIST ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli')
  );
}

export function cliBinaryPath(platform: CliPlatform): string {
  return path.join(cliDistDir(), platform.file);
}

/** A platform plus whether its binary is actually bundled in this build. */
export interface CliPlatformStatus extends CliPlatform {
  available: boolean;
  size: number | null;
}

export function cliPlatformStatus(platform: CliPlatform): CliPlatformStatus {
  try {
    const stat = statSync(cliBinaryPath(platform));
    return { ...platform, available: stat.isFile(), size: stat.size };
  } catch {
    return { ...platform, available: false, size: null };
  }
}

/** Every shipped platform with its bundled/absent status. */
export function cliManifest(): CliPlatformStatus[] {
  return CLI_PLATFORMS.map(cliPlatformStatus);
}
