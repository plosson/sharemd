#!/usr/bin/env bun
// Compile the standalone `sharemd` binaries for every shipped platform into
// dist/cli. Driven by the CLI_PLATFORMS registry (single source of truth,
// shared with the download API and install scripts). Run at Docker image build
// time and by the release workflow; locally via `bun run build:cli`.
//
// The CLI has no native/per-platform dependencies (yjs, y-websocket, and the
// MCP SDK are pure JS), so a single host cross-compiles self-contained
// binaries for all platforms — no per-OS build matrix.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CLI_PLATFORMS, cliDistDir } from '../src/cli/platforms';

const outDir = cliDistDir();
mkdirSync(outDir, { recursive: true });

for (const platform of CLI_PLATFORMS) {
  const outfile = path.join(outDir, platform.file);
  const args = ['build', 'src/cli/index.ts', '--compile', `--target=${platform.bunTarget}`, '--outfile', outfile];
  console.log(`building ${platform.id} -> ${outfile}`);
  const result = Bun.spawnSync(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) {
    console.error(`build:cli failed for ${platform.id} (exit ${result.exitCode})`);
    process.exit(result.exitCode ?? 1);
  }
}

console.log(`done — ${CLI_PLATFORMS.length} sharemd binaries in ${outDir}`);
