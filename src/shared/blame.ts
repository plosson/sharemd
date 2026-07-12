import * as Y from 'yjs';

/**
 * Line-level authorship ("blame") computed from the CRDT itself: every Yjs item
 * permanently carries the clientID that inserted it, and the `authors` map inside
 * the doc translates those per-session clientIDs to durable identities.
 *
 * Requires docs created with `gc: false` — snapshot diffs need deleted item
 * structure to survive locally.
 */

export const TEXT_KEY = 'content';
export const AUTHORS_KEY = 'authors';

export interface AuthorInfo {
  name: string;
  color?: string;
  role?: 'human' | 'agent' | 'system';
}

export interface BlameAuthor extends AuthorInfo {
  chars: number;
}

export interface BlameLine {
  line: number;
  authors: BlameAuthor[];
}

/** Record this doc connection's identity so blame can resolve its clientID. Call before editing. */
export function registerAuthor(doc: Y.Doc, info: AuthorInfo): void {
  doc.getMap<AuthorInfo>(AUTHORS_KEY).set(String(doc.clientID), info);
}

const UNKNOWN_AUTHOR: AuthorInfo = { name: 'unknown' };

/**
 * Compute per-line authorship of the surviving text. Characters are attributed to
 * the peer that inserted them; a line lists every contributing author with a
 * UTF-16 char count (its newline counts toward the line it ends), aggregated by
 * name and sorted by contribution.
 */
export function blameLines(doc: Y.Doc): BlameLine[] {
  const ytext = doc.getText(TEXT_KEY);
  const authorsMap = doc.getMap<AuthorInfo>(AUTHORS_KEY);
  const delta = ytext.toDelta(Y.snapshot(doc), Y.emptySnapshot, (_type, id) => ({
    client: id.client,
  })) as Array<{ insert?: unknown; attributes?: { ychange?: { client: number } } }>;

  const lines: BlameLine[] = [];
  let current = new Map<string, BlameAuthor>();
  let currentChars = 0;

  const closeLine = () => {
    lines.push({
      line: lines.length + 1,
      authors: [...current.values()].sort((a, b) => b.chars - a.chars),
    });
    current = new Map();
    currentChars = 0;
  };

  for (const run of delta) {
    if (typeof run.insert !== 'string' || run.insert.length === 0) {
      continue;
    }
    const client = run.attributes?.ychange?.client;
    const info = (client !== undefined && authorsMap.get(String(client))) || UNKNOWN_AUTHOR;
    let segmentStart = 0;
    while (segmentStart <= run.insert.length) {
      const newline = run.insert.indexOf('\n', segmentStart);
      const segmentEnd = newline < 0 ? run.insert.length : newline + 1;
      const chars = segmentEnd - segmentStart;
      if (chars > 0) {
        const entry = current.get(info.name);
        if (entry) {
          entry.chars += chars;
        } else {
          current.set(info.name, { ...info, chars });
        }
        currentChars += chars;
      }
      if (newline < 0) {
        break;
      }
      closeLine();
      segmentStart = segmentEnd;
    }
  }
  if (currentChars > 0) {
    closeLine();
  }
  return lines;
}
