import { getMcpConfig } from './api';

/**
 * MCP-config overlay: everything a human needs to wire an agent into the
 * current project — the binary install one-liner, the `mdio mcp install`
 * command, and the raw `.mcp.json` entry — each with a copy button. The
 * content comes from GET /api/projects/:p/mcp-config, so the server URL is
 * the caller-visible origin (reverse-proxy aware).
 */

const overlay = document.querySelector('#mcp-config')! as HTMLElement;
const titleEl = document.querySelector('#mcp-config-title')!;
const bodyEl = document.querySelector('#mcp-config-body')!;
const closeButton = document.querySelector('#mcp-config-close')! as HTMLButtonElement;

function block(label: string, text: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'mcp-block';

  const head = document.createElement('div');
  head.className = 'mcp-block-head';
  const caption = document.createElement('span');
  caption.textContent = label;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mcp-copy';
  copy.textContent = 'copy';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(text).then(() => {
      copy.textContent = '✓ copied';
      setTimeout(() => {
        copy.textContent = 'copy';
      }, 1500);
    });
  });
  head.append(caption, copy);

  const pre = document.createElement('pre');
  pre.textContent = text;

  section.append(head, pre);
  return section;
}

closeButton.addEventListener('click', closeMcpConfig);

export function closeMcpConfig(): void {
  overlay.hidden = true;
  bodyEl.innerHTML = '';
}

export async function openMcpConfig(project: string, username: string): Promise<void> {
  titleEl.textContent = `${project} — MCP config`;
  bodyEl.innerHTML = '';
  overlay.hidden = false;
  try {
    const config = await getMcpConfig(project, username);
    bodyEl.append(
      block('1. Install the mdio binary (once per machine)', config.install),
      block('2. Wire the agent’s workspace (writes .mcp.json + the skill)', config.configure),
      block('Or paste the entry into .mcp.json yourself', JSON.stringify({ mcpServers: config.mcpServers }, null, 2)),
    );
    const hint = document.createElement('p');
    hint.className = 'mcp-hint';
    hint.textContent =
      `The agent joins as "${config.username}" and sees only the "${config.project}" project — ` +
      'edit the username to wire a different peer.';
    bodyEl.append(hint);
  } catch (error) {
    const failed = document.createElement('p');
    failed.className = 'mcp-hint';
    failed.textContent = error instanceof Error ? error.message : String(error);
    bodyEl.append(failed);
  }
}
