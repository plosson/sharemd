/**
 * Tiny DOM helpers shared by the surface renderers (Home, Inbox, Agents,
 * Settings). Plain DOM, no framework — `el` just trims the createElement
 * boilerplate, and the rest are formatting/interaction bits reused across
 * surfaces so they stay visually consistent.
 */

type Child = Node | string | number | null | undefined | false;

interface ElProps {
  class?: string;
  text?: string;
  title?: string;
  href?: string;
  type?: string;
  hidden?: boolean;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  onClick?: (event: MouseEvent) => void;
}

/** Build an element: `el('div', { class: 'card' }, child, child)`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.class) node.className = props.class;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.title !== undefined) node.title = props.title;
    if (props.type) node.setAttribute('type', props.type);
    if (props.href && node instanceof HTMLAnchorElement) node.href = props.href;
    if (props.hidden) node.hidden = true;
    if (props.dataset) {
      for (const [key, value] of Object.entries(props.dataset)) {
        node.dataset[key] = value;
      }
    }
    if (props.style) Object.assign(node.style, props.style);
    if (props.onClick) node.addEventListener('click', props.onClick);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

/** A one-line human phrase for an activity event kind (feeds on Home + Agents). */
export function activityLabel(kind: string, detail?: string): string {
  switch (kind) {
    case 'joined':
      return 'joined';
    case 'left':
      return 'left';
    case 'writing':
      return detail ? `started writing in §${detail}` : 'started writing';
    case 'finished':
      return 'finished writing';
    case 'suggested':
      return 'suggested an edit';
    case 'accepted':
      return 'accepted a suggestion';
    case 'rejected':
      return 'rejected a suggestion';
    case 'commented':
      return 'commented';
    case 'replied':
      return 'replied';
    case 'resolved':
      return 'resolved a thread';
    case 'saved':
      return detail ? `saved version “${detail}”` : 'saved a version';
    case 'restored':
      return detail ? `restored version “${detail}”` : 'restored a version';
    default:
      return kind;
  }
}

/** A compact relative time like "just now", "5m ago", "3d ago", or a date. */
export function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Initial shown in a presence avatar (agents drop the owner/ prefix). */
export function peerInitial(name: string): string {
  const own = name.split('/').pop() ?? name;
  return (own[0] ?? '?').toUpperCase();
}

/** A presence avatar span (round for humans, rounded-square for agents). */
export function avatar(peer: { name: string; role?: string | null; color?: string | null }): HTMLElement {
  return el('span', {
    class: peer.role === 'agent' ? 'avatar agent' : 'avatar human',
    text: peerInitial(peer.name),
    title: peer.name,
    style: { background: peer.color ?? '#888' },
  });
}

/** A labelled command block with a copy button (the pattern from the old MCP modal). */
export function commandBlock(label: string, text: string): HTMLElement {
  const copy = el('button', { class: 'copy-btn', type: 'button', text: 'copy' });
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(text).then(() => {
      copy.textContent = '✓ copied';
      setTimeout(() => {
        copy.textContent = 'copy';
      }, 1500);
    });
  });
  const pre = el('pre', { class: 'command-pre', text });
  return el(
    'section',
    { class: 'command-block' },
    el('div', { class: 'command-head' }, el('span', { text: label }), copy),
    pre,
  );
}
