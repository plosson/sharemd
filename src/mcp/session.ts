import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { TEXT_KEY, registerAuthor } from '../shared/blame';

export interface AgentIdentity {
  name: string;
  color: string;
  colorLight: string;
  /** "agent" when the name is owner-scoped ("plosson/claude"), "human" otherwise. */
  role: 'human' | 'agent';
}

export type AgentStatus = 'idle' | 'composing';

/** A live Yjs peer connection to one sharemd document. */
export class DocumentSession {
  // gc:false so locally-synced deleted items survive for blame computation.
  readonly doc = new Y.Doc({ gc: false });
  readonly provider: WebsocketProvider;
  readonly ytext: Y.Text;
  readonly origin: { source: 'agent'; name: string };

  private constructor(
    readonly serverWsBase: string,
    readonly path: string,
    readonly identity: AgentIdentity,
  ) {
    this.origin = { source: 'agent', name: identity.name };
    this.ytext = this.doc.getText(TEXT_KEY);
    registerAuthor(this.doc, { name: identity.name, color: identity.color, role: identity.role });
    this.provider = new WebsocketProvider(serverWsBase, path, this.doc, {
      disableBc: true,
      maxBackoffTime: 4000,
    });
    this.provider.awareness.setLocalStateField('user', {
      name: identity.name,
      color: identity.color,
      colorLight: identity.colorLight,
      role: identity.role,
      status: 'idle' satisfies AgentStatus,
    });
  }

  static async open(
    serverWsBase: string,
    path: string,
    identity: AgentIdentity,
    timeoutMs = 10_000,
  ): Promise<DocumentSession> {
    const session = new DocumentSession(serverWsBase, path, identity);
    await session.waitForSync(timeoutMs).catch((error) => {
      session.destroy();
      throw error;
    });
    return session;
  }

  private waitForSync(timeoutMs: number): Promise<void> {
    if (this.provider.synced) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.provider.off('sync', onSync);
        reject(new Error(`Timed out syncing "${this.path}" after ${timeoutMs}ms — is the sharemd server running at ${this.serverWsBase}?`));
      }, timeoutMs);
      const onSync = (synced: boolean) => {
        if (!synced) {
          return;
        }
        clearTimeout(timer);
        this.provider.off('sync', onSync);
        resolve();
      };
      this.provider.on('sync', onSync);
    });
  }

  setStatus(status: AgentStatus): void {
    const previous = this.provider.awareness.getLocalState()?.user ?? {};
    this.provider.awareness.setLocalStateField('user', { ...previous, status });
  }

  /** Broadcast the agent caret at a character index (rendered by y-codemirror.next in browsers). */
  setCursor(index: number | null): void {
    if (index === null) {
      this.provider.awareness.setLocalStateField('cursor', null);
      return;
    }
    const clamped = Math.max(0, Math.min(index, this.ytext.length));
    const position = Y.createRelativePositionFromTypeIndex(this.ytext, clamped);
    this.provider.awareness.setLocalStateField('cursor', {
      anchor: Y.relativePositionToJSON(position),
      head: Y.relativePositionToJSON(position),
    });
  }

  transact(fn: () => void): void {
    this.doc.transact(fn, this.origin);
  }

  destroy(): void {
    try {
      this.provider.awareness.setLocalState(null);
    } catch {
      // Best-effort presence cleanup.
    }
    this.provider.destroy();
    this.doc.destroy();
  }
}
