// CLI distribution: the server ships its own client binaries. `GET /install.sh`
// (and /install.ps1) are rendered from the calling server's public origin, so
// `curl -fsSL <server>/install.sh | sh` installs an `mdio` binary that knows
// which server it came from; `/api/cli/*` serves the manifest, the version, and
// the binaries baked into the image by scripts/build-cli.ts. Everything is
// driven by the CLI_PLATFORMS registry — one new entry ships a new platform.
import pkg from '../../package.json';
import { CLI_PLATFORMS, cliBinaryPath, cliManifest, cliPlatform } from '../cli/platforms';

/** The `mdio` binary filename for unix platforms (all share it). */
function unixBinaryName(): string {
  return CLI_PLATFORMS.find((platform) => platform.os === 'unix')?.saveAs ?? 'mdio';
}

/** Space-separated `os-arch` ids this build ships unix binaries for. */
function unixTargets(): string {
  return CLI_PLATFORMS.filter((platform) => platform.os === 'unix')
    .map((platform) => platform.id)
    .join(' ');
}

/** The shipped Windows platform (id + filename), if any. */
function windowsPlatform(): { id: string; saveAs: string } | undefined {
  const platform = CLI_PLATFORMS.find((entry) => entry.os === 'windows');
  return platform ? { id: platform.id, saveAs: platform.saveAs } : undefined;
}

/**
 * POSIX `sh` installer/updater for Linux/macOS. Detects the platform, downloads
 * the matching binary from `base` into `$MDIO_INSTALL_DIR` (default
 * `~/.local/bin`, no sudo), and wires PATH. When run with `MDIO_UPDATE=1`
 * (by `mdio update`) it instead version-checks against the server and, if
 * different, atomically replaces the running binary at `$MDIO_CURRENT_BIN`.
 */
export function renderInstallSh(base: string): string {
  const bin = unixBinaryName();
  return `#!/bin/sh
# ${bin} installer/updater.
# Install:  curl -fsSL ${base}/install.sh | sh   (or | MDIO_INSTALL_DIR=~/bin sh)
# Update:   handled by '${bin} update' (re-runs this with MDIO_UPDATE=1).
set -eu

BASE="${base}"
BIN="${bin}"
SUPPORTED="${unixTargets()}"
INSTALL_DIR="\${MDIO_INSTALL_DIR:-$HOME/.local/bin}"
# Pre-rename \`sharemd\` binaries still send SHAREMD_* — honour both spellings.
MODE="\${MDIO_UPDATE:-\${SHAREMD_UPDATE:-}}"
MODE="\${MODE:+update}"

err() { echo "$BIN install: $1" >&2; exit 1; }
# Fetch a URL to stdout ($1) or to a file ($2): curl, falling back to wget.
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else err "need curl or wget"; fi
}
download() {
  if command -v curl >/dev/null 2>&1; then curl -fSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else err "need curl or wget"; fi
}

# --- detect platform ---
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS '$os' — on Windows use: irm ${base}/install.ps1 | iex" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac
target="$os-$arch"

found=0
for p in $SUPPORTED; do
  [ "$p" = "$target" ] && found=1
done
[ "$found" -eq 1 ] || err "this server ships no $BIN binary for '$target' (available: $SUPPORTED)"

# --- pick destination (and, when updating, decide whether an update is needed) ---
if [ "$MODE" = update ]; then
  dest="\${MDIO_CURRENT_BIN:-\${SHAREMD_CURRENT_BIN:-}}"
  [ -n "$dest" ] || err "update requires MDIO_CURRENT_BIN — run '$BIN update'"
  current="\${MDIO_CURRENT_VERSION:-\${SHAREMD_CURRENT_VERSION:-}}"
  if [ -z "$current" ] && [ -x "$dest" ]; then
    current=$("$dest" version 2>/dev/null | head -n1 | tr -d ' \\t\\r\\n')
  fi
  latest=$(fetch "$BASE/api/cli/version" | tr -d ' \\t\\r\\n')
  [ -n "$latest" ] || err "could not read the latest version from $BASE"
  if [ -n "$current" ] && [ "$current" = "$latest" ]; then
    echo "$BIN is already up to date ($current)."
    exit 0
  fi
  echo "Updating $BIN \${current:-?} -> $latest ..."
else
  mkdir -p "$INSTALL_DIR"
  dest="$INSTALL_DIR/$BIN"
fi

# --- download + install ---
# Stage the download in the destination directory so the final move is a same-fs
# rename — atomic, and safe even when replacing the currently-running binary.
url="$BASE/api/cli/$target"
dest_dir=$(dirname "$dest")
tmp=$(mktemp "$dest_dir/.$BIN.XXXXXX" 2>/dev/null || mktemp 2>/dev/null || mktemp -t "$BIN")
trap 'rm -f "$tmp"' EXIT
[ "$MODE" = update ] || echo "Downloading $BIN ($target) from $url ..."
download "$url" "$tmp"
chmod +x "$tmp"
mv "$tmp" "$dest"
trap - EXIT

if [ "$MODE" = update ]; then
  echo "Updated $BIN to $latest ($dest)."
  exit 0
fi

echo "Installed $BIN to $dest"

# --- PATH ---
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    line="export PATH=\\"$INSTALL_DIR:\\$PATH\\""
    added=""
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -e "$rc" ] || continue
      grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null && continue
      printf '\\n# Added by ${bin} installer\\n%s\\n' "$line" >>"$rc"
      added="$added $rc"
    done
    if [ -e "$HOME/.config/fish/config.fish" ]; then
      fish_cfg="$HOME/.config/fish/config.fish"
      if ! grep -qF "$INSTALL_DIR" "$fish_cfg" 2>/dev/null; then
        printf '\\n# Added by ${bin} installer\\nset -gx PATH %s $PATH\\n' "$INSTALL_DIR" >>"$fish_cfg"
        added="$added $fish_cfg"
      fi
    fi
    if [ -n "$added" ]; then
      echo "Added $INSTALL_DIR to PATH in:$added — restart your shell, or run: $line"
    else
      echo "Add $INSTALL_DIR to your PATH: $line"
    fi
    ;;
esac

echo ""
echo "$BIN is ready. Next, from the project where your agent runs:"
echo "  $BIN mcp install --server $BASE --username you/agent   # wire ./.mcp.json"
echo "  $BIN skill install                                     # teach Claude the workflows"
echo "Update later with: $BIN update"
`;
}

/**
 * PowerShell installer/updater for Windows: installs under
 * %LOCALAPPDATA%\\mdio\\bin and adds it to the user PATH; in update mode it
 * renames the running exe aside first (Windows can't overwrite a running exe).
 */
export function renderInstallPs1(base: string): string {
  const windows = windowsPlatform();
  if (!windows) {
    return `$ErrorActionPreference = 'Stop'\nWrite-Error "This ${unixBinaryName()} server ships no Windows binary."\n`;
  }
  const bin = windows.saveAs.replace(/\.exe$/i, '');
  return `# ${bin} installer/updater (Windows).
# Install:  irm ${base}/install.ps1 | iex
# Update:   handled by '${bin} update' (re-runs this with MDIO_UPDATE=1).
$ErrorActionPreference = 'Stop'

$base = '${base}'
$target = '${windows.id}'
$exeName = '${windows.saveAs}'
# Pre-rename 'sharemd' binaries still send SHAREMD_* — honour both spellings.
$update = -not ([string]::IsNullOrEmpty($env:MDIO_UPDATE) -and [string]::IsNullOrEmpty($env:SHAREMD_UPDATE))

if (-not [Environment]::Is64BitOperatingSystem) {
  Write-Error '${bin} requires 64-bit Windows.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- pick destination (and, when updating, decide whether an update is needed) ---
if ($update) {
  $dest = if ($env:MDIO_CURRENT_BIN) { $env:MDIO_CURRENT_BIN } else { $env:SHAREMD_CURRENT_BIN }
  if ([string]::IsNullOrEmpty($dest)) { Write-Error "update requires MDIO_CURRENT_BIN — run '${bin} update'" }
  $current = if ($env:MDIO_CURRENT_VERSION) { $env:MDIO_CURRENT_VERSION } else { $env:SHAREMD_CURRENT_VERSION }
  if ([string]::IsNullOrEmpty($current) -and (Test-Path $dest)) {
    $current = ((& $dest version) | Select-Object -First 1).Trim()
  }
  $latest = (Invoke-RestMethod -Uri "$base/api/cli/version").ToString().Trim()
  if ($current -and $current -eq $latest) {
    Write-Host "${bin} is already up to date ($current)."
    return
  }
  Write-Host "Updating ${bin} $(if ($current) { $current } else { '?' }) -> $latest ..."
} else {
  $installDir = Join-Path $env:LOCALAPPDATA '${bin}\\bin'
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $dest = Join-Path $installDir $exeName
}

# --- download + install ---
$url = "$base/api/cli/$target"
if (-not $update) { Write-Host "Downloading ${bin} ($target) from $url ..." }
# Windows locks a running exe against overwrite but allows renaming it aside.
if ($update -and (Test-Path $dest)) {
  Remove-Item -LiteralPath "$dest.old" -Force -ErrorAction SilentlyContinue
  Rename-Item -LiteralPath $dest -NewName ([System.IO.Path]::GetFileName("$dest.old"))
}
Invoke-WebRequest -Uri $url -OutFile $dest
if ($update) {
  Remove-Item -LiteralPath "$dest.old" -Force -ErrorAction SilentlyContinue
  Write-Host "Updated ${bin} to $latest ($dest)."
  return
}

# --- PATH (user scope, idempotent) ---
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = $userPath -split ';' | Where-Object { $_ -eq $installDir }
if (-not $onPath) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$installDir"
  Write-Host "Added $installDir to your user PATH (restart terminals to pick it up)."
}

Write-Host "Installed $exeName to $dest"
Write-Host ''
Write-Host "${bin} is ready. Next, from the project where your agent runs:"
Write-Host "  ${bin} mcp install --server $base --username you/agent"
Write-Host "  ${bin} skill install"
Write-Host "Update later with: ${bin} update"
`;
}

/** The public base URL as the client sees it (honouring reverse-proxy headers). */
export function publicOrigin(req: Request, url: URL): string {
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(/:$/, '');
  const host =
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || url.host;
  return `${proto}://${host}`;
}

function scriptResponse(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Handle a CLI-distribution route, or return null if `url` is none of ours. */
export async function handleCliRoute(req: Request, url: URL): Promise<Response | null> {
  switch (url.pathname) {
    case '/install.sh':
      return scriptResponse(renderInstallSh(publicOrigin(req, url)));
    case '/install.ps1':
      return scriptResponse(renderInstallPs1(publicOrigin(req, url)));
    case '/api/cli':
      return Response.json({
        version: pkg.version,
        platforms: cliManifest().map(({ id, label, os, saveAs, available, size }) => ({
          id,
          label,
          os,
          filename: saveAs,
          available,
          size,
        })),
      });
    case '/api/cli/version':
      return new Response(pkg.version, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (url.pathname.startsWith('/api/cli/')) {
    const id = url.pathname.slice('/api/cli/'.length);
    const platform = cliPlatform(id);
    if (!platform) {
      return new Response(`Unknown CLI platform: ${id}`, { status: 404 });
    }
    const blob = Bun.file(cliBinaryPath(platform));
    if (!(await blob.exists())) {
      return new Response(`CLI binary not bundled in this build: ${id}`, { status: 404 });
    }
    // BunFile body keeps memory O(1); explicit Content-Length gives clients a real progress bar.
    return new Response(blob, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(blob.size),
        'Content-Disposition': `attachment; filename="${platform.saveAs}"`,
      },
    });
  }
  return null;
}
