/**
 * Per-project agent/human activity feed. Answers "what did my agent do while I
 * was away?" by collecting the events already flowing through the room — joins,
 * writing intent, suggestions, comments, and version saves/restores.
 *
 * Deliberately EPHEMERAL: an in-memory ring buffer per project that resets on
 * server restart and is never persisted (unlike a document's `.mdio/*.log`
 * history). It is a live activity view, not a durable audit trail.
 */

export type ActivityKind =
  | 'joined'
  | 'left'
  | 'writing'
  | 'finished'
  | 'suggested'
  | 'accepted'
  | 'rejected'
  | 'commented'
  | 'replied'
  | 'resolved'
  | 'saved'
  | 'restored';

export interface ActivityEvent {
  ts: number;
  /** Peer that performed the action (a human name or an `owner/agent` name). */
  actor: string;
  role: 'human' | 'agent';
  kind: ActivityKind;
  /** Project-relative document path the event happened in (empty when none). */
  doc: string;
  /** Variable specifics: the section for `writing`, the label for `saved`/`restored`. */
  detail?: string;
}

/** Kept small — this is a glanceable "recent activity" view, not history. */
const MAX_EVENTS = 500;

export class ActivityLog {
  private readonly byProject = new Map<string, ActivityEvent[]>();

  /** Append an event; silently drops one with no resolvable actor. */
  record(project: string, event: Omit<ActivityEvent, 'ts'> & { ts?: number }): void {
    if (!event.actor || event.actor === 'disk') {
      return; // no resolvable actor — drop rather than guess
    }
    const events = this.byProject.get(project) ?? [];
    events.push({ ts: event.ts ?? Date.now(), ...event });
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
    this.byProject.set(project, events);
  }

  /** Events for a project in chronological order (oldest first). */
  list(project: string): ActivityEvent[] {
    return this.byProject.get(project) ?? [];
  }
}

/** Blame-style role from a peer name: `owner/agent` is an agent, a plain name a human. */
export function roleOfName(name: string): 'human' | 'agent' {
  return name.includes('/') ? 'agent' : 'human';
}
