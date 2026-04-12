import type { AgentEvent, ImageBlock } from '@dash/agent';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';

export interface ChatWsOptions {
  agents: AgentChatCoordinator;
  token?: string;
  upgradeWebSocket: UpgradeWebSocket;
  /** When true, log every inbound and outbound WebSocket message. */
  verbose?: boolean;
}

/** Truncate long fields (like base64 images) so logs stay readable. */
function summarizeForLog(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > 200 ? `${value.slice(0, 200)}…(${value.length} chars)` : value;
  if (Array.isArray(value)) return value.map(summarizeForLog);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = summarizeForLog(v);
    }
    return out;
  }
  return value;
}

interface WsMessageImage {
  mediaType: string;
  data: string;
}

type WsClientMessage =
  | {
      type: 'message';
      id: string;
      agentId: string;
      channelId: string;
      conversationId: string;
      text: string;
      images?: WsMessageImage[];
      streamingBehavior?: 'steer' | 'followUp';
    }
  | { type: 'cancel'; id: string };

type WsServerMessage =
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; error: string };

function validateMessage(msg: unknown): msg is WsClientMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.type !== 'string') return false;

  if (m.type === 'cancel') return true;

  if (m.type === 'message') {
    const valid =
      typeof m.agentId === 'string' &&
      typeof m.channelId === 'string' &&
      typeof m.conversationId === 'string' &&
      typeof m.text === 'string';
    if (!valid) return false;
    if (m.images !== undefined) {
      if (!Array.isArray(m.images)) return false;
      for (const img of m.images) {
        if (typeof img !== 'object' || img === null) return false;
        if (typeof (img as Record<string, unknown>).mediaType !== 'string') return false;
        if (typeof (img as Record<string, unknown>).data !== 'string') return false;
      }
    }
    return true;
  }

  return false;
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

export function mountChatWs(app: Hono, options: ChatWsOptions): void {
  const { agents, upgradeWebSocket, verbose = false } = options;

  const logInbound = (raw: string, parsed: unknown): void => {
    if (!verbose) return;
    console.log('[chat-ws] ← inbound', JSON.stringify(summarizeForLog(parsed)));
  };

  const sendServerMessage = (ws: { send(data: string): void }, msg: WsServerMessage): void => {
    const payload = JSON.stringify(msg, (_key, value) =>
      value instanceof Error ? value.message : value,
    );
    if (verbose) {
      const summary =
        msg.type === 'event'
          ? `event:${msg.event?.type ?? '?'}`
          : msg.type === 'error'
            ? `error:${msg.error}`
            : msg.type;
      console.log(`[chat-ws] → outbound id=${msg.id} ${summary}`);
    }
    ws.send(payload);
  };

  app.get(
    '/ws/chat',
    upgradeWebSocket((c) => {
      // Auth via query param
      if (options.token) {
        const token = c.req.query('token');
        if (!token || token !== options.token) {
          return {
            onOpen(_event, ws) {
              ws.close(4001, 'Unauthorized');
            },
          };
        }
      }

      // Track active streams by message ID
      const activeStreams = new Map<string, { controller: AbortController }>();
      // Track active streams by conversation key for steer/followUp detection
      const conversationStreams = new Map<string, string>(); // convKey → messageId

      return {
        onMessage(event, ws) {
          const raw = typeof event.data === 'string' ? event.data : '';
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            if (verbose) console.log('[chat-ws] ← invalid JSON:', raw.slice(0, 200));
            sendServerMessage(ws, { type: 'error', id: '', error: 'Invalid JSON' });
            return;
          }

          logInbound(raw, parsed);

          if (!validateMessage(parsed)) {
            const id =
              typeof (parsed as Record<string, unknown>).id === 'string'
                ? ((parsed as Record<string, unknown>).id as string)
                : '';
            sendServerMessage(ws, {
              type: 'error',
              id,
              error: 'Invalid message: missing required fields',
            });
            return;
          }

          const msg = parsed;

          if (msg.type === 'cancel') {
            const entry = activeStreams.get(msg.id);
            if (entry) {
              entry.controller.abort();
              activeStreams.delete(msg.id);
            }
            sendServerMessage(ws, { type: 'done', id: msg.id });
            return;
          }

          if (msg.type === 'message') {
            const agentId = msg.agentId;
            const convId = msg.conversationId;
            const channelId = msg.channelId;
            const text = msg.text;
            const convKey = conversationKey(agentId, convId);

            const images: ImageBlock[] | undefined = msg.images?.map((img) => ({
              type: 'image' as const,
              mediaType: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: img.data,
            }));

            // Check if there's an active stream on the same conversation
            const existingMsgId = conversationStreams.get(convKey);
            if (existingMsgId && activeStreams.has(existingMsgId)) {
              const behavior = msg.streamingBehavior;
              if (behavior === 'steer') {
                agents.steer(agentId, convId, text, images).catch((err) => {
                  sendServerMessage(ws, {
                    type: 'error',
                    id: msg.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
                return;
              }
              if (behavior === 'followUp') {
                agents.followUp(agentId, convId, text, images).catch((err) => {
                  sendServerMessage(ws, {
                    type: 'error',
                    id: msg.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
                return;
              }
            }

            // Start a new stream
            const controller = new AbortController();
            activeStreams.set(msg.id, { controller });
            conversationStreams.set(convKey, msg.id);

            (async () => {
              const stream = agents.chat({
                agentId,
                conversationId: convId,
                channelId,
                text,
                images: images?.length ? images : undefined,
              });
              try {
                for await (const agentEvent of stream) {
                  if (controller.signal.aborted) break;

                  if (agentEvent.type === 'error') {
                    (agentEvent as { timestamp?: string }).timestamp = new Date().toISOString();
                  }
                  sendServerMessage(ws, { type: 'event', id: msg.id, event: agentEvent });
                }
                if (!controller.signal.aborted) {
                  sendServerMessage(ws, { type: 'done', id: msg.id });
                }
              } catch (err) {
                const errStr = err instanceof Error ? err.message : String(err);
                if (verbose) {
                  console.error('[chat-ws] stream threw:', err instanceof Error ? err.stack : err);
                }

                if (!controller.signal.aborted) {
                  sendServerMessage(ws, { type: 'error', id: msg.id, error: errStr });
                }
              } finally {
                activeStreams.delete(msg.id);
                if (conversationStreams.get(convKey) === msg.id) {
                  conversationStreams.delete(convKey);
                }
                await stream.return(undefined);
              }
            })();
          }
        },

        onClose() {
          for (const { controller } of activeStreams.values()) {
            controller.abort();
          }
          activeStreams.clear();
          conversationStreams.clear();
        },
      };
    }),
  );
}
