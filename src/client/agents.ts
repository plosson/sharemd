/**
 * Agents page (`/<project>/agents`): a Tailscale-style "connect a device" flow
 * that replaces the old MCP-config modal. Install the CLI, choose an identity
 * (the `mdio mcp install …` command and the raw `.mcp.json` re-render live as
 * you type), then wait — the page polls the project's peers and flips to
 * "connected" when the chosen identity shows up. Below, the peers already in the
 * project are listed with their live status.
 */

import * as api from './api';
import { toast } from './dialogs';
import { parseUsername } from '../mcp/identity';
import type { SurfaceContext } from './surface';
import { activityLabel, avatar, commandBlock, el, relativeTime } from './ui';

/** How many recent events the Agents-page activity feed shows (newest first). */
const ACTIVITY_LIMIT = 40;

const POLL_MS = 3000;

/** Validate an owner/agent identity the same way the server does; null if OK. */
function identityError(identity: string): string | null {
  try {
    parseUsername(identity);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function installCommand(server: string): string {
  return `curl -fsSL ${server}/install.sh | sh`;
}

function configureCommand(server: string, identity: string, project: string): string {
  return (
    `mdio mcp install --server ${server} --username ${identity} --project ${project}` +
    ` && mdio skill install`
  );
}

function mcpJson(server: string, identity: string, project: string): string {
  return JSON.stringify(
    { mcpServers: { mdio: { command: 'mdio', args: ['mcp'], env: { MDIO_SERVER: server, MDIO_USERNAME: identity, MDIO_PROJECT: project } } } },
    null,
    2,
  );
}

function statusLabel(peer: api.ProjectPeer): string {
  if (peer.status === 'composing') {
    return `writing in ${peer.doc}`;
  }
  return `in ${peer.doc}`;
}

export function renderAgents(host: HTMLElement, ctx: SurfaceContext, project: string): void {
  const root = el('div', { class: 'agents' });
  host.append(root);
  root.append(
    el(
      'div',
      { class: 'surface-head' },
      el('h1', { text: 'Agents' }),
      el('p', { class: 'surface-sub', text: `Connect an AI agent to “${project}” as a live peer.` }),
    ),
    el('p', { class: 'agents-loading', text: 'Loading connection details…' }),
  );

  void (async () => {
    let config: api.McpConfig;
    try {
      config = await api.getMcpConfig(project, `${ctx.me.name}/claude`);
    } catch (error) {
      root.replaceChildren(el('p', { class: 'agents-loading', text: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const server = config.server;
    let identity = `${ctx.me.name}/claude`;

    // Step 2 lives-rendered command blocks.
    const configureHost = el('div');
    const jsonHost = el('div');
    const renderCommands = () => {
      configureHost.replaceChildren(commandBlock('2. Wire the project (writes .mcp.json + the skill)', configureCommand(server, identity, project)));
      jsonHost.replaceChildren(commandBlock('.mcp.json entry', mcpJson(server, identity, project)));
    };

    const input = el('input', { class: 'agents-identity', type: 'text' }) as HTMLInputElement;
    input.value = identity;
    input.spellcheck = false;
    input.autocomplete = 'off';
    const identityErr = el('p', { class: 'agents-error', hidden: true });
    const status = el('div', { class: 'agents-status waiting' });
    const statusText = el('span', { text: `Waiting for “${identity}” to connect…` });
    status.append(el('span', { class: 'agents-spinner' }), statusText);

    const refreshStatus = () => {
      const error = identityError(input.value.trim());
      identityErr.hidden = error === null;
      identityErr.textContent = error ?? '';
      if (!error) {
        identity = input.value.trim();
        renderCommands();
        if (!connected) {
          statusText.textContent = `Waiting for “${identity}” to connect…`;
        }
      }
    };
    input.addEventListener('input', refreshStatus);

    const disclosure = el('details', { class: 'agents-disclosure' });
    disclosure.append(el('summary', { text: 'Paste the .mcp.json entry yourself' }), jsonHost);

    const peersList = el('div', { class: 'agents-peers' });
    const activityList = el('div', { class: 'agents-activity' });
    let connected = false;

    renderCommands();
    root.replaceChildren(
      el(
        'div',
        { class: 'surface-head' },
        el('h1', { text: 'Agents' }),
        el('p', { class: 'surface-sub', text: `Connect an AI agent to “${project}” as a live peer.` }),
      ),
      commandBlock('1. Install the mdio CLI (once per machine)', installCommand(server)),
      el(
        'section',
        { class: 'agents-step' },
        el('label', { class: 'agents-label', text: 'Agent identity' }),
        input,
        identityErr,
      ),
      configureHost,
      disclosure,
      status,
      el('section', { class: 'agents-section' }, el('h2', { text: 'Connected agents' }), peersList),
      el('section', { class: 'agents-section' }, el('h2', { text: 'Recent activity' }), activityList),
    );

    const renderActivity = (events: api.ActivityEvent[]) => {
      if (events.length === 0) {
        activityList.replaceChildren(
          el('p', { class: 'agents-empty', text: 'No activity yet — it appears here as agents join and edit.' }),
        );
        return;
      }
      // Newest first, capped; the server keeps chronological order.
      const recent = events.slice(-ACTIVITY_LIMIT).reverse();
      activityList.replaceChildren(
        ...recent.map((event) =>
          el(
            'div',
            { class: 'activity-row' },
            avatar({ name: event.actor, role: event.role }),
            el(
              'div',
              { class: 'activity-main' },
              el(
                'span',
                { class: 'activity-text' },
                el('span', { class: 'activity-actor', text: event.actor }),
                ` ${activityLabel(event.kind, event.detail)} in `,
                el('button', {
                  class: 'activity-doc',
                  type: 'button',
                  text: event.doc,
                  onClick: () => ctx.go({ kind: 'doc', project, doc: `${project}/${event.doc}` }),
                }),
              ),
              el('span', { class: 'activity-time', text: relativeTime(event.ts) }),
            ),
          ),
        ),
      );
    };

    const renderPeers = (peers: api.ProjectPeer[]) => {
      if (peers.length === 0) {
        peersList.replaceChildren(el('p', { class: 'agents-empty', text: 'No one is connected right now.' }));
        return;
      }
      peersList.replaceChildren(
        ...peers.map((peer) =>
          el(
            'div',
            { class: 'agents-peer' },
            avatar(peer),
            el(
              'div',
              { class: 'agents-peer-main' },
              el('span', { class: 'agents-peer-name', text: peer.name }),
              el('span', { class: 'agents-peer-status', text: statusLabel(peer) }),
            ),
            el('span', { class: `online-dot ${peer.role}` }),
          ),
        ),
      );
    };

    const poll = async () => {
      if (!root.isConnected) {
        clearInterval(timer);
        return;
      }
      let peers: api.ProjectPeer[];
      try {
        peers = await api.getPeers(project);
      } catch {
        return;
      }
      renderPeers(peers);
      await api.getActivity(project).then(renderActivity).catch(() => {});
      const match = peers.find((peer) => peer.name === identity);
      if (match && !connected) {
        connected = true;
        status.classList.remove('waiting');
        status.classList.add('connected');
        status.replaceChildren(el('span', { text: `✓ ${identity} connected` }));
        toast(`${identity} connected`);
      } else if (!match && connected) {
        // It dropped: go back to waiting so a reconnect is visible.
        connected = false;
        status.classList.add('waiting');
        status.classList.remove('connected');
        status.replaceChildren(el('span', { class: 'agents-spinner' }), el('span', { text: `Waiting for “${identity}” to connect…` }));
      }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    void poll();
  })();
}
