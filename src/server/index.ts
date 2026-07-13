import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { Room, RoomRegistry, type RoomSocket } from './rooms';
import { Vault } from './vault';
import { handleCliRoute } from './cli-routes';
import { blameLines } from '../shared/blame';

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'client');

interface SocketData {
  room: Room;
  peer: RoomSocket | null;
}

export interface MdioServer {
  port: number;
  url: string;
  registry: RoomRegistry;
  stop(): Promise<void>;
}

async function buildClient(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(CLIENT_DIR, 'main.ts')],
    target: 'browser',
    minify: true,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'Client bundle failed');
  }
  return result.outputs[0]!.text();
}

export async function startServer({
  vaultDir,
  port = 4321,
}: {
  vaultDir: string;
  port?: number;
}): Promise<MdioServer> {
  await mkdir(vaultDir, { recursive: true }); // fresh deploys start with an empty vault
  const vault = new Vault(vaultDir);
  const registry = new RoomRegistry(vault);
  const [clientBundle, indexHtml, styles] = await Promise.all([
    buildClient(),
    Bun.file(join(CLIENT_DIR, 'index.html')).text(),
    Bun.file(join(CLIENT_DIR, 'styles.css')).text(),
  ]);

  const server: Server = Bun.serve<SocketData, object>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname.startsWith('/ws/')) {
        const docPath = decodeURIComponent(url.pathname.slice('/ws/'.length));
        let room: Room;
        try {
          room = await registry.open(docPath);
        } catch (error) {
          return new Response(error instanceof Error ? error.message : 'Invalid document', {
            status: 400,
          });
        }
        if (srv.upgrade(req, { data: { room, peer: null } satisfies SocketData })) {
          return undefined as unknown as Response;
        }
        return new Response('WebSocket upgrade required', { status: 426 });
      }

      if (url.pathname.startsWith('/api/history/')) {
        const docPath = decodeURIComponent(url.pathname.slice('/api/history/'.length));
        try {
          const room = await registry.open(docPath);
          await room.flushLog();
          return new Response(await vault.readLog(docPath), {
            headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
          });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : 'Invalid document', {
            status: 400,
          });
        }
      }

      if (url.pathname.startsWith('/api/blame/')) {
        const docPath = decodeURIComponent(url.pathname.slice('/api/blame/'.length));
        try {
          const room = await registry.open(docPath);
          return Response.json({ path: docPath, lines: blameLines(room.doc) });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : 'Invalid document', {
            status: 400,
          });
        }
      }

      const cliResponse = await handleCliRoute(req, url);
      if (cliResponse) {
        return cliResponse;
      }

      switch (url.pathname) {
        case '/':
          return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        case '/app.js':
          return new Response(clientBundle, {
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
          });
        case '/styles.css':
          return new Response(styles, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
        case '/api/docs':
          return Response.json({ docs: await vault.list(url.searchParams.get('project') ?? undefined) });
        case '/api/projects':
          return Response.json({ projects: await vault.listProjects() });
        default:
          // Documents live at stable paths (/project/notes/plan.md) and bare
          // project pages at /project: serve the app shell for both, 404 the rest.
          if (
            req.method === 'GET' &&
            (/\.(md|markdown|txt)$/i.test(url.pathname) || /^\/[^/.]+\/?$/.test(url.pathname))
          ) {
            return new Response(indexHtml, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
          }
          return new Response('Not found', { status: 404 });
      }
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const peer: RoomSocket = {
          send(data: Uint8Array) {
            ws.send(data);
          },
        };
        ws.data.peer = peer;
        ws.data.room.connect(peer);
      },
      message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
        if (typeof message === 'string' || !ws.data.peer) {
          return;
        }
        ws.data.room.handleMessage(ws.data.peer, new Uint8Array(message));
      },
      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.peer) {
          ws.data.room.disconnect(ws.data.peer);
          ws.data.peer = null;
        }
      },
    },
  });

  return {
    port: server.port!,
    url: `http://localhost:${server.port}`,
    registry,
    async stop() {
      await registry.flushAll();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SHAREMD_')) {
      console.error(`warning: ${key} is ignored — env vars were renamed, use MDIO_${key.slice('SHAREMD_'.length)}.`);
    }
  }
  const args = Bun.argv.slice(2);
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.MDIO_PORT || 4321);
  const vaultDir =
    args.find((arg, i) => !arg.startsWith('--') && (portFlag < 0 || i !== portFlag + 1)) ??
    process.env.MDIO_VAULT ??
    './vault';

  const running = await startServer({ vaultDir, port });
  console.log(`mdio serving ${vaultDir}`);
  console.log(`Web UI:  ${running.url}`);
  console.log(`Sync:    ws://localhost:${running.port}/ws/<doc-path>`);

  const shutdown = async () => {
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
