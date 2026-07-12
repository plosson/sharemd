import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Vault } from './vault';
import { TEXT_KEY, registerAuthor } from '../shared/blame';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

export { TEXT_KEY };
const HYDRATE_ORIGIN = 'sharemd-hydrate';
const DISK_AUTHOR = { name: 'disk', role: 'system' as const };

export interface RoomSocket {
  send(data: Uint8Array): void;
}

/**
 * Replace the ytext content with `target` via a minimal middle-splice (common
 * prefix/suffix preserved), so unchanged text keeps its original authorship.
 */
function reconcileText(ytext: Y.Text, target: string): void {
  const current = ytext.toString();
  if (current === target) {
    return;
  }
  const maxShared = Math.min(current.length, target.length);
  let prefix = 0;
  while (prefix < maxShared && current[prefix] === target[prefix]) {
    prefix++;
  }
  // Never split a surrogate pair at the splice boundary.
  if (prefix > 0 && current.charCodeAt(prefix - 1) >= 0xd800 && current.charCodeAt(prefix - 1) <= 0xdbff) {
    prefix--;
  }
  let suffix = 0;
  while (
    suffix < maxShared - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix++;
  }
  const low = (s: string, fromEnd: number) => {
    const code = s.charCodeAt(s.length - fromEnd);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  if (suffix > 0 && low(current, suffix) && low(target, suffix)) {
    suffix--;
  }
  ytext.delete(prefix, current.length - prefix - suffix);
  ytext.insert(prefix, target.slice(prefix, target.length - suffix));
}

/** One collaborative document: a Y.Doc hydrated from a vault file, persisted back on change. */
export class Room {
  // gc:false keeps deleted items so authorship (and later, snapshot history) survives.
  readonly doc = new Y.Doc({ gc: false });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly sockets = new Map<RoomSocket, Set<number>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersisted: string | null = null;
  private stateDirty = false;
  private persistChain: Promise<void> = Promise.resolve();

  private constructor(
    readonly name: string,
    private readonly vault: Vault,
    private readonly persistDebounceMs: number,
  ) {
    this.awareness.setLocalState(null);

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
      this.stateDirty = true;
      if (origin !== HYDRATE_ORIGIN) {
        this.schedulePersist();
      }
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        const controlled = origin && this.sockets.get(origin as RoomSocket);
        if (controlled) {
          added.forEach((id) => controlled.add(id));
          removed.forEach((id) => controlled.delete(id));
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  static async open(name: string, vault: Vault, persistDebounceMs: number): Promise<Room> {
    const room = new Room(name, vault, persistDebounceMs);
    const [content, state] = await Promise.all([vault.read(name), vault.readState(name)]);

    let hydratedFromState = false;
    if (state) {
      try {
        Y.applyUpdate(room.doc, state, HYDRATE_ORIGIN);
        hydratedFromState = true;
      } catch (error) {
        console.error(`sharemd: unreadable state sidecar for "${name}", rebuilding from markdown:`, error);
      }
    }

    // The markdown file stays the source of truth for content; the sidecar only
    // contributes history. Any divergence (offline edit, deleted file, corrupt
    // sidecar) is reconciled as a minimal "disk"-authored edit.
    const fileText = content ?? (hydratedFromState ? '' : null);
    if (fileText !== null) {
      const ytext = room.doc.getText(TEXT_KEY);
      if (ytext.toString() !== fileText) {
        room.doc.transact(() => {
          registerAuthor(room.doc, DISK_AUTHOR);
          reconcileText(ytext, fileText);
        }, HYDRATE_ORIGIN);
      }
      room.lastPersisted = content;
    }
    return room;
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  connect(socket: RoomSocket): void {
    this.sockets.set(socket, new Set());

    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, this.doc);
    socket.send(encoding.toUint8Array(sync));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      socket.send(encoding.toUint8Array(encoder));
    }
  }

  disconnect(socket: RoomSocket): void {
    const controlled = this.sockets.get(socket);
    this.sockets.delete(socket);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null);
    }
  }

  handleMessage(socket: RoomSocket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, socket);
        if (encoding.length(encoder) > 1) {
          socket.send(encoding.toUint8Array(encoder));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          socket,
        );
        break;
      }
      case MESSAGE_QUERY_AWARENESS: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]),
        );
        socket.send(encoding.toUint8Array(encoder));
        break;
      }
      default:
        break;
    }
  }

  private broadcast(data: Uint8Array): void {
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(data);
      } catch {
        // A failed send will surface as a close event; nothing to do here.
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, this.persistDebounceMs);
  }

  persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      const content = this.doc.getText(TEXT_KEY).toString();
      if (content !== this.lastPersisted) {
        await this.vault.write(this.name, content);
        this.lastPersisted = content;
      }
      // The sidecar also changes when content doesn't (authors map, tombstones),
      // so it is tracked by update dirtiness rather than by text.
      if (this.stateDirty) {
        this.stateDirty = false;
        await this.vault.writeState(this.name, Y.encodeStateAsUpdate(this.doc));
      }
    });
    return this.persistChain;
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Promise<Room>>();

  constructor(
    private readonly vault: Vault,
    private readonly persistDebounceMs = 400,
  ) {}

  open(name: string): Promise<Room> {
    let room = this.rooms.get(name);
    if (!room) {
      this.vault.resolvePath(name); // reject invalid paths before caching a room
      room = Room.open(name, this.vault, this.persistDebounceMs);
      room.catch(() => this.rooms.delete(name));
      this.rooms.set(name, room);
    }
    return room;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map(async (pending) => (await pending).flush()));
  }
}
