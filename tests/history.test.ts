import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import * as Y from 'yjs';
import { connectPeer, startTestServer, waitFor, type TestPeer } from './helpers';
import { startServer, type MdioServer } from '../src/server/index';
import { STATE_DIR } from '../src/server/vault';

let server: MdioServer;
let vaultDir: string;
const peers: TestPeer[] = [];

beforeAll(async () => {
  ({ server, vaultDir } = await startTestServer());
});

afterAll(async () => {
  for (const peer of peers) {
    peer.destroy();
  }
  await server.stop();
});

async function peer(docPath: string): Promise<TestPeer> {
  const connected = await connectPeer(server, docPath);
  peers.push(connected);
  return connected;
}

interface LogEntry {
  ts: number;
  update: Uint8Array;
}

async function readLog(docPath: string): Promise<LogEntry[]> {
  const raw = await Bun.file(join(vaultDir, STATE_DIR, `${docPath}.log`)).text();
  return raw
    .trim()
    .split('\n')
    .map((line) => {
      const { ts, update } = JSON.parse(line) as { ts: number; update: string };
      return { ts, update: Uint8Array.from(Buffer.from(update, 'base64')) };
    });
}

function replayText(entries: LogEntry[], upTo = entries.length): string {
  const doc = new Y.Doc({ gc: false });
  for (const entry of entries.slice(0, upTo)) {
    Y.applyUpdate(doc, entry.update);
  }
  return doc.getText('content').toString();
}

describe('history log', () => {
  test('seeds on first open and records edits; replay reproduces the document', async () => {
    const alice = await peer('demo.md');
    alice.text.insert(0, 'first-edit\n');
    alice.text.insert(alice.text.length, '\nsecond-edit\n');
    const room = await server.registry.open('demo.md');
    await waitFor(() => room.doc.getText('content').toString().includes('second-edit'), {
      label: 'server to receive edits',
    });
    await server.registry.flushAll();

    const entries = await readLog('demo.md');
    expect(entries.length).toBeGreaterThanOrEqual(3); // full-state seed + both edits
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.ts).toBeGreaterThanOrEqual(entries[i - 1]!.ts);
    }
    expect(replayText(entries)).toBe(alice.text.toString());
    // A replay prefix is an earlier state, not garbage.
    expect(replayText(entries, 1)).not.toInclude('second-edit');
  });

  test('restart reuses the log without duplicating history', async () => {
    await server.registry.flushAll();
    const before = await readLog('demo.md');
    await server.stop();

    server = await startServer({ vaultDir, port: 0 });
    const alice = await peer('demo.md');
    await server.registry.flushAll();

    const after = await readLog('demo.md');
    expect(after.length).toBe(before.length);
    expect(replayText(after)).toBe(alice.text.toString());
  });

  test('offline disk edits are reconciled into the log on restart', async () => {
    await server.stop();
    const file = join(vaultDir, 'demo.md');
    const edited = `${await Bun.file(file).text()}\nedited-on-disk\n`;
    await Bun.write(file, edited);

    server = await startServer({ vaultDir, port: 0 });
    const alice = await peer('demo.md');
    expect(alice.text.toString()).toBe(edited);

    const entries = await readLog('demo.md');
    expect(replayText(entries)).toBe(edited);
  });

  test('serves the log over HTTP as NDJSON', async () => {
    const alice = await peer('other.md');
    alice.text.insert(alice.text.length, 'via-http\n');
    const room = await server.registry.open('other.md');
    await waitFor(() => room.doc.getText('content').toString().includes('via-http'), {
      label: 'server to receive edit',
    });

    const response = await fetch(`${server.url}/api/history/other.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('application/x-ndjson');
    const entries = (await response.text())
      .trim()
      .split('\n')
      .map((line) => {
        const { ts, update } = JSON.parse(line) as { ts: number; update: string };
        return { ts, update: Uint8Array.from(Buffer.from(update, 'base64')) };
      });
    expect(replayText(entries)).toBe(alice.text.toString());

    const invalid = await fetch(`${server.url}/api/history/..%2Fescape.md`);
    expect(invalid.status).toBe(400);
  });

  test('a missing sidecar restarts the log from a full-state seed', async () => {
    await server.stop();
    const { unlink } = await import('node:fs/promises');
    await unlink(join(vaultDir, STATE_DIR, 'demo.md.yjs'));

    server = await startServer({ vaultDir, port: 0 });
    const alice = await peer('demo.md');

    const entries = await readLog('demo.md');
    expect(entries.length).toBe(1);
    expect(replayText(entries)).toBe(alice.text.toString());
  });
});
