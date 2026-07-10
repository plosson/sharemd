import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Vault } from './vault';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

export const TEXT_KEY = 'content';
const HYDRATE_ORIGIN = 'sharemd-hydrate';

export interface RoomSocket {
  send(data: Uint8Array): void;
}

/** One collaborative document: a Y.Doc hydrated from a vault file, persisted back on change. */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly sockets = new Map<RoomSocket, Set<number>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersisted: string | null = null;
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
    const content = await vault.read(name);
    if (content !== null) {
      room.doc.transact(() => {
        room.doc.getText(TEXT_KEY).insert(0, content);
      }, HYDRATE_ORIGIN);
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
      if (content === this.lastPersisted) {
        return;
      }
      await this.vault.write(this.name, content);
      this.lastPersisted = content;
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
