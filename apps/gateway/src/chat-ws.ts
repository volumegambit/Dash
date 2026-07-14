import type { AgentEvent, ImageBlock } from '@dash/agent';
import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { toMobileApiError } from './conversation-routes.js';
import { ConversationServiceError } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import type { ResumableChatHub, ResumableSendFrame, TurnFrameSink } from './resumable-chat-hub.js';

export interface ChatWsOptions {
  agents: AgentChatCoordinator;
  resumableChatHub: ResumableChatHub;
  token?: string;
  upgradeWebSocket: UpgradeWebSocket;
  /**
   * Durable event log. Every outbound WS frame is appended here
   * BEFORE being sent, so MC can resume a dropped connection via
   * the replay HTTP endpoint. Optional so tests that don't care
   * about persistence can pass a no-op or omit it; the wire
   * protocol is unchanged if `seq` is left out.
   */
  eventLogStore?: EventLogStore;
  /** When true, log every inbound and outbound WebSocket message. */
  verbose?: boolean;
  /**
   * Swarm coordinator hook: an explicit user cancel of a chat turn must
   * also terminalize that conversation's live swarm workers (a bare
   * socket close intentionally does NOT — it is indistinguishable from a
   * network drop, and dropped consumers reconcile via the event log while
   * workers finish). Structural type so tests can pass a stub.
   */
  swarmCoordinator?: { cancelTurn(agentId: string, conversationId: string): boolean };
}

const KNOWN_CLIENT_FRAME_TYPES = new Set(['message', 'resume', 'answer', 'cancel']);
const STRUCTURAL_CLIENT_FIELDS = new Set([
  'type',
  'id',
  'agentId',
  'channelId',
  'conversationId',
  'questionId',
  'sinceSeq',
  'resumable',
  'streamingBehavior',
  'text',
  'answer',
  'images',
]);

/** Allowlist protocol metadata; never recursively serialize untrusted values. */
function summarizeInboundForLog(raw: string, value: unknown): Record<string, unknown> {
  const byteLength = Buffer.byteLength(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { frameType: 'invalid', byteLength };
  }
  const record = value as Record<string, unknown>;
  const type =
    typeof record.type === 'string' && KNOWN_CLIENT_FRAME_TYPES.has(record.type)
      ? record.type
      : 'unknown';
  const summary: Record<string, unknown> = {
    frameType: type,
    byteLength,
    recognizedKeys: Object.keys(record)
      .filter((key) => STRUCTURAL_CLIENT_FIELDS.has(key))
      .sort(),
  };
  if (type === 'unknown') return summary;

  for (const key of ['id', 'agentId', 'channelId', 'conversationId', 'questionId'] as const) {
    const item = record[key];
    if (typeof item === 'string') summary[`${key}Length`] = item.length;
  }
  if (typeof record.sinceSeq === 'number') summary.sinceSeq = record.sinceSeq;
  if (typeof record.resumable === 'boolean') summary.resumable = record.resumable;
  if (record.streamingBehavior === 'steer' || record.streamingBehavior === 'followUp') {
    summary.streamingBehavior = record.streamingBehavior;
  }
  if (typeof record.text === 'string') summary.textLength = record.text.length;
  if (typeof record.answer === 'string') summary.answerLength = record.answer.length;
  if (Array.isArray(record.images)) {
    summary.imageCount = record.images.length;
    summary.imageDataCharacters = record.images.reduce((total, image) => {
      if (!image || typeof image !== 'object') return total;
      const data = (image as Record<string, unknown>).data;
      return total + (typeof data === 'string' ? data.length : 0);
    }, 0);
  }
  return summary;
}

/** Describe failures without serializing their message, stack, cause, or custom properties. */
function summarizeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorKind: 'error', errorMessageLength: error.message.length };
  }
  if (typeof error === 'string') {
    return { errorKind: 'string', errorMessageLength: error.length };
  }
  return {
    errorKind: error === null ? 'null' : Array.isArray(error) ? 'array' : typeof error,
  };
}

type WsServerMessage =
  | { type: 'event'; id: string; seq?: number; event: AgentEvent }
  | { type: 'done'; id: string; seq?: number }
  | { type: 'error'; id: string; seq?: number; error: string };

function summarizeOutboundForLog(
  msg: WsServerMessage | MobileWsServerFrame,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { frameType: msg.type };
  if (typeof msg.id === 'string') summary.idLength = msg.id.length;
  if ('seq' in msg && typeof msg.seq === 'number') summary.seq = msg.seq;
  if (msg.type === 'event') summary.eventType = msg.event?.type ?? 'unknown';
  if (msg.type === 'error') {
    summary.errorMessageLength = msg.error.length;
    if ('code' in msg && typeof msg.code === 'string') summary.errorCode = msg.code;
    if ('retryable' in msg && typeof msg.retryable === 'boolean') {
      summary.retryable = msg.retryable;
    }
  }
  return summary;
}

/**
 * A conversationId must be a plain identifier, never a filesystem path. It is
 * used to key durable session/event-log directories, so any path hazard is a
 * traversal risk. This is deliberately permissive: MC UUIDs, `e2e-123`,
 * `chan:42`, and channel ids with spaces/apostrophes like `Bob's Bot:42` all
 * pass. It rejects ONLY the four path hazards — a `/` or `\` separator, a `..`
 * parent-dir hop, a leading `.` (dotfile), or an unreasonable length (>128).
 */
export function isValidConversationId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  if (id.includes('/') || id.includes('\\')) return false;
  if (id.includes('..')) return false;
  if (id.startsWith('.')) return false;
  return true;
}

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

function decodedBase64Bytes(data: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return -1;
  return Buffer.from(data, 'base64').byteLength;
}

export function parseChatClientFrame(msg: unknown): MobileWsClientFrame | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.type !== 'string') return null;

  if (m.type === 'cancel') return msg as MobileWsClientFrame;

  if (m.type === 'answer') {
    if (typeof m.questionId !== 'string' || typeof m.answer !== 'string') return null;
    return msg as MobileWsClientFrame;
  }

  if (m.type === 'resume') {
    if (
      typeof m.agentId !== 'string' ||
      typeof m.conversationId !== 'string' ||
      !isValidConversationId(m.conversationId) ||
      !Number.isInteger(m.sinceSeq) ||
      (m.sinceSeq as number) < 0
    ) {
      return null;
    }
    return msg as MobileWsClientFrame;
  }

  if (m.type === 'message') {
    const valid =
      typeof m.agentId === 'string' &&
      typeof m.channelId === 'string' &&
      typeof m.conversationId === 'string' &&
      typeof m.text === 'string';
    if (!valid) return null;
    if (!isValidConversationId(m.conversationId as string)) return null;
    if (m.resumable !== undefined && typeof m.resumable !== 'boolean') return null;
    if (
      m.streamingBehavior !== undefined &&
      m.streamingBehavior !== 'steer' &&
      m.streamingBehavior !== 'followUp'
    ) {
      return null;
    }
    if (m.images !== undefined) {
      if (!Array.isArray(m.images)) return null;
      if (m.resumable === true && m.images.length > MAX_IMAGES) return null;
      let totalBytes = 0;
      for (const img of m.images) {
        if (typeof img !== 'object' || img === null) return null;
        const image = img as Record<string, unknown>;
        if (typeof image.mediaType !== 'string' || typeof image.data !== 'string') return null;
        if (m.resumable !== true) continue;
        if (!ALLOWED_IMAGE_TYPES.has(image.mediaType)) return null;
        const bytes = decodedBase64Bytes(image.data);
        if (bytes < 0 || bytes > MAX_IMAGE_BYTES) return null;
        totalBytes += bytes;
        if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return null;
      }
    }
    return msg as MobileWsClientFrame;
  }

  return null;
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

export function mountChatWs(app: Hono, options: ChatWsOptions): void {
  const { agents, resumableChatHub, upgradeWebSocket, verbose = false, eventLogStore } = options;

  /**
   * Append a payload to the durable event log and return the assigned
   * seq, or `undefined` if no log is wired up. Swallows log errors —
   * chat streaming MUST NOT fail because the log has a bad disk day.
   * The ONLY cost of a failed append is that MC can't replay that
   * specific event, which is already the existing failure mode.
   */
  const logPayload = (
    agentId: string,
    conversationId: string,
    msgId: string,
    payload: Parameters<EventLogStore['append']>[3],
  ): number | undefined => {
    if (!eventLogStore) return undefined;
    try {
      return eventLogStore.append(agentId, conversationId, msgId, payload);
    } catch (err) {
      console.error('[chat-ws] event log append failed', summarizeErrorForLog(err));
      return undefined;
    }
  };

  const logInbound = (raw: string, parsed: unknown): void => {
    if (!verbose) return;
    console.log('[chat-ws] ← inbound', JSON.stringify(summarizeInboundForLog(raw, parsed)));
  };

  const sendServerMessage = (
    ws: { send(data: string): void },
    msg: WsServerMessage | MobileWsServerFrame,
  ): void => {
    const payload = JSON.stringify(msg, (_key, value) =>
      value instanceof Error ? value.message : value,
    );
    if (verbose) {
      console.log('[chat-ws] → outbound', JSON.stringify(summarizeOutboundForLog(msg)));
    }
    ws.send(payload);
  };

  const sendHubError = (
    ws: { send(data: string): void },
    id: string,
    conversationId: string | undefined,
    error: unknown,
  ): void => {
    if (!(error instanceof ConversationServiceError)) {
      console.error('[chat-ws] resumable dispatch failed', summarizeErrorForLog(error));
    }
    const mapped = toMobileApiError(error);
    const activeTurnId = mapped.body.details?.activeTurnId;
    sendServerMessage(ws, {
      type: 'error',
      id,
      ...(conversationId !== undefined ? { conversationId } : {}),
      error: mapped.body.error,
      code: mapped.body.code,
      retryable: mapped.body.retryable,
      ...(typeof activeTurnId === 'string' ? { activeTurnId } : {}),
    });
  };

  const dispatchHub = (
    ws: { send(data: string): void },
    id: string,
    conversationId: string | undefined,
    operation: () => void | Promise<void>,
  ): void => {
    try {
      void Promise.resolve(operation()).catch((error) => {
        sendHubError(ws, id, conversationId, error);
      });
    } catch (error) {
      sendHubError(ws, id, conversationId, error);
    }
  };

  app.get(
    '/ws/chat',
    upgradeWebSocket((c) => {
      // Native clients keep credentials out of URLs with Authorization.
      // Browser WebSockets cannot set headers, so retain query fallback only
      // when the header is absent; a malformed/present header never downgrades.
      if (options.token) {
        const authorization = c.req.header('Authorization');
        const authorized =
          authorization !== undefined
            ? authorization === `Bearer ${options.token}`
            : c.req.query('token') === options.token;
        if (!authorized) {
          return {
            onOpen(_event, ws) {
              ws.close(4001, 'Unauthorized');
            },
          };
        }
      }

      // Track active streams by message ID
      const activeStreams = new Map<
        string,
        { controller: AbortController; agentId: string; conversationId: string }
      >();
      // Track active streams by conversation key for steer/followUp detection
      const conversationStreams = new Map<string, string>(); // convKey → messageId
      let connectionSocket: { send(data: string): void } | undefined;
      const sink: TurnFrameSink = {
        send(frame) {
          if (!connectionSocket) throw new Error('Chat WebSocket is not open');
          sendServerMessage(connectionSocket, frame);
        },
      };

      return {
        onOpen(_event, ws) {
          connectionSocket = ws;
        },

        onMessage(event, ws) {
          connectionSocket = ws;
          const raw = typeof event.data === 'string' ? event.data : '';
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            if (verbose) console.log(`[chat-ws] ← invalid JSON (${raw.length} bytes)`);
            sendServerMessage(ws, { type: 'error', id: '', error: 'Invalid JSON' });
            return;
          }

          logInbound(raw, parsed);

          const msg = parseChatClientFrame(parsed);
          if (!msg) {
            const invalid =
              typeof parsed === 'object' && parsed !== null
                ? (parsed as Record<string, unknown>)
                : undefined;
            const id = typeof invalid?.id === 'string' ? invalid.id : '';
            const conversationId =
              typeof invalid?.conversationId === 'string' ? invalid.conversationId : undefined;
            sendServerMessage(ws, {
              type: 'error',
              id,
              ...(conversationId !== undefined ? { conversationId } : {}),
              error: 'Invalid message: missing required fields',
              code: 'validation_failed',
              retryable: false,
            });
            return;
          }

          if (msg.type === 'resume') {
            dispatchHub(ws, msg.id, msg.conversationId, () => resumableChatHub.resume(msg, sink));
            return;
          }

          if (msg.type === 'answer') {
            const entry = activeStreams.get(msg.id);
            if (entry) {
              dispatchHub(ws, msg.id, undefined, () =>
                agents.answerQuestion(
                  entry.agentId,
                  entry.conversationId,
                  msg.questionId,
                  msg.answer,
                ),
              );
            } else {
              dispatchHub(ws, msg.id, undefined, () =>
                resumableChatHub.answer(msg.id, msg.questionId, msg.answer),
              );
            }
            return;
          }

          if (msg.type === 'cancel') {
            const entry = activeStreams.get(msg.id);
            if (entry) {
              entry.controller.abort();
              activeStreams.delete(msg.id);
              const key = conversationKey(entry.agentId, entry.conversationId);
              if (conversationStreams.get(key) === msg.id) conversationStreams.delete(key);
              agents.cancel(entry.agentId, entry.conversationId);
              // A user cancel terminalizes the conversation's live swarm
              // workers too — aborting the orchestrator alone would leave
              // them running (and billing) headless.
              options.swarmCoordinator?.cancelTurn(entry.agentId, entry.conversationId);
              sendServerMessage(ws, { type: 'done', id: msg.id });
            } else {
              dispatchHub(ws, msg.id, undefined, () => resumableChatHub.cancel(msg.id, sink));
            }
            return;
          }

          if (msg.type === 'message') {
            if (msg.resumable === true) {
              dispatchHub(ws, msg.id, msg.conversationId, () =>
                resumableChatHub.start(msg as ResumableSendFrame, sink),
              );
              return;
            }
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
            activeStreams.set(msg.id, { controller, agentId, conversationId: convId });
            conversationStreams.set(convKey, msg.id);

            (async () => {
              const stream = agents.chat({
                agentId,
                conversationId: convId,
                channelId,
                text,
                images: images?.length ? images : undefined,
                messageId: msg.id,
                signal: controller.signal,
              });
              try {
                for await (const agentEvent of stream) {
                  if (controller.signal.aborted) break;

                  if (agentEvent.type === 'error') {
                    (agentEvent as { timestamp?: string }).timestamp = new Date().toISOString();
                  }
                  // Append to the durable log FIRST, then send over
                  // the WS. Order matters: if the WS is already
                  // dead, the log still captures the event so MC
                  // can replay it on reconnect.
                  const seq = logPayload(agentId, convId, msg.id, {
                    type: 'event',
                    event: agentEvent,
                  });
                  sendServerMessage(ws, { type: 'event', id: msg.id, seq, event: agentEvent });
                }
                if (!controller.signal.aborted) {
                  const seq = logPayload(agentId, convId, msg.id, { type: 'done' });
                  sendServerMessage(ws, { type: 'done', id: msg.id, seq });
                }
              } catch (err) {
                const errStr = err instanceof Error ? err.message : String(err);
                if (verbose) {
                  console.error('[chat-ws] stream threw', summarizeErrorForLog(err));
                }

                if (!controller.signal.aborted) {
                  const seq = logPayload(agentId, convId, msg.id, {
                    type: 'error',
                    error: errStr,
                  });
                  sendServerMessage(ws, { type: 'error', id: msg.id, seq, error: errStr });
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
          resumableChatHub.detach(sink);
          for (const { controller, agentId, conversationId } of activeStreams.values()) {
            controller.abort();
            agents.cancel(agentId, conversationId);
            options.swarmCoordinator?.cancelTurn(agentId, conversationId);
          }
          activeStreams.clear();
          conversationStreams.clear();
          connectionSocket = undefined;
        },
      };
    }),
  );
}
