import type { AgentIdentity } from './session';

/**
 * Identity convention: MDIO_USERNAME is either a plain human username
 * ("plosson") or an owner-scoped agent name ("plosson/claude"). A "/" means the
 * peer is an agent acting on behalf of the owner before the slash and implies
 * role "agent"; without it the peer joins as a regular human. This is a naming
 * convention, not authentication — the server trusts what peers declare.
 */

const PALETTE = ['#e05252', '#2f7fd1', '#1a9c74', '#c2571f', '#8a4bbf', '#c23b64'];

export interface ParsedUsername {
  name: string;
  owner: string | null;
  role: 'human' | 'agent';
}

export function parseUsername(raw: string): ParsedUsername {
  const name = raw.trim();
  if (!name) {
    throw new Error('MDIO_USERNAME must not be empty.');
  }
  if (/\s/.test(name)) {
    throw new Error(`MDIO_USERNAME must not contain whitespace: "${name}"`);
  }
  const segments = name.split('/');
  if (segments.length > 2) {
    throw new Error(`MDIO_USERNAME may contain at most one "/" (owner/agent): "${name}"`);
  }
  if (segments.some((segment) => !segment)) {
    throw new Error(`MDIO_USERNAME has an empty owner or agent segment: "${name}"`);
  }
  return segments.length === 2
    ? { name, owner: segments[0]!, role: 'agent' }
    : { name, owner: null, role: 'human' };
}

/**
 * The project this MCP peer is scoped to. Like identity, it comes from the MCP
 * config env, not tool arguments — the peer sees nothing outside its project.
 */
export function resolveProject(env: Record<string, string | undefined>): string {
  const project = env.MDIO_PROJECT?.trim();
  if (!project) {
    throw new Error(
      'MDIO_PROJECT is required — an MCP peer is scoped to one project of the vault, e.g. MDIO_PROJECT=main.',
    );
  }
  if (project.includes('/') || /\s/.test(project) || project.startsWith('.')) {
    throw new Error(`MDIO_PROJECT must be a plain project name (no "/", spaces, or leading dot): "${project}"`);
  }
  return project;
}

export function resolveIdentity(env: Record<string, string | undefined>): AgentIdentity {
  const raw = env.MDIO_USERNAME;
  if (!raw) {
    const legacyHint = env.SHAREMD_USERNAME || env.SHAREMD_AGENT_NAME
      ? ' SHAREMD_* env vars were replaced by MDIO_* — set MDIO_USERNAME, "owner/agent" for agents, e.g. "plosson/claude".'
      : '';
    throw new Error(`MDIO_USERNAME is required — set it in the MCP server config env.${legacyHint}`);
  }
  const { name, role } = parseUsername(raw);
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  const color = env.MDIO_AGENT_COLOR || PALETTE[Math.abs(hash) % PALETTE.length]!;
  return { name, color, colorLight: `${color}33`, role };
}
