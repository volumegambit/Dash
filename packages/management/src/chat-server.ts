import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { ChatServerOptions, WsClientMessage, WsServerMessage } from './types.js';

function validateMessage(msg: unknown): msg is WsClientMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.type !== 'string') return false;

  if (m.type === 'cancel') return true;

  if (m.type === 'message') {
    return (
      typeof m.agent === 'string' &&
      typeof m.channelId === 'string' &&
      typeof m.conversationId === 'string' &&
      typeof m.text === 'string'
    );
  }

  return false;
}

export function createChatApp(options: ChatServerOptions) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      // Auth via query param
      const token = c.req.query('token');
      if (!token || token !== options.token) {
        return {
          onOpen(_event, ws) {
            ws.close(4001, 'Unauthorized');
          },
        };
      }

      // Track active streams so we can stop them on disconnect
      const activeStreams = new Map<string, AbortController>();

      return {
        onMessage(event, ws) {
          const raw = typeof event.data === 'string' ? event.data : '';
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            const errMsg: WsServerMessage = {
              type: 'error',
              id: '',
              error: 'Invalid JSON',
            };
            ws.send(JSON.stringify(errMsg));
            return;
          }

          if (!validateMessage(parsed)) {
            const id =
              typeof (parsed as Record<string, unknown>).id === 'string'
                ? ((parsed as Record<string, unknown>).id as string)
                : '';
            const errMsg: WsServerMessage = {
              type: 'error',
              id,
              error: 'Invalid message: missing required fields',
            };
            ws.send(JSON.stringify(errMsg));
            return;
          }

          const msg = parsed;

          if (msg.type === 'cancel') {
            const controller = activeStreams.get(msg.id);
            if (controller) {
              controller.abort();
              activeStreams.delete(msg.id);
            }
            const ack: WsServerMessage = { type: 'done', id: msg.id };
            ws.send(JSON.stringify(ack));
            return;
          }

          if (msg.type === 'message') {
            const agent = options.agents.get(msg.agent);
            if (!agent) {
              const errMsg: WsServerMessage = {
                type: 'error',
                id: msg.id,
                error: `Unknown agent: ${msg.agent}`,
              };
              ws.send(JSON.stringify(errMsg));
              return;
            }

            const controller = new AbortController();
            activeStreams.set(msg.id, controller);

            (async () => {
              const stream = agent.chat(msg.channelId, msg.conversationId, msg.text);
              try {
                for await (const agentEvent of stream) {
                  if (controller.signal.aborted) break;
                  const serverMsg: WsServerMessage = {
                    type: 'event',
                    id: msg.id,
                    event: agentEvent,
                  };
                  ws.send(JSON.stringify(serverMsg));
                }
                if (!controller.signal.aborted) {
                  const done: WsServerMessage = { type: 'done', id: msg.id };
                  ws.send(JSON.stringify(done));
                }
              } catch (err) {
                if (!controller.signal.aborted) {
                  const errMsg: WsServerMessage = {
                    type: 'error',
                    id: msg.id,
                    error: err instanceof Error ? err.message : String(err),
                  };
                  ws.send(JSON.stringify(errMsg));
                }
              } finally {
                activeStreams.delete(msg.id);
                await stream.return(undefined);
              }
            })();
          }
        },

        onClose() {
          // Abort all active streams when the client disconnects
          for (const controller of activeStreams.values()) {
            controller.abort();
          }
          activeStreams.clear();
        },
      };
    }),
  );

  return { app, injectWebSocket };
}

export function startChatServer(options: ChatServerOptions): {
  server: Server;
  close: () => Promise<void>;
} {
  const { app, injectWebSocket } = createChatApp(options);

  const server = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: '127.0.0.1',
  }) as Server;

  injectWebSocket(server);

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
