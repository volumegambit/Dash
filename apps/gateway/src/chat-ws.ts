import type { AgentEvent, ImageBlock } from '@dash/agent';
import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import { CHAT_INPUT_QUEUE_CAPABILITY, type MobileV2WsServerFrame } from '@dash/mobile-contract-v2';
import type { Env, Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { type AdmissionLease, GatewayAdmissionController } from './admission-controller.js';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { parseMobileV2ClientFrame, summarizeMobileV2Inbound } from './chat-ws-v2.js';
import { toClientLocation } from './client-location.js';
import { toMobileApiError } from './conversation-routes.js';
import { ConversationServiceError } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import type {
  ResumableChatHub,
  ResumableSendFrame,
  TurnFrameSink,
  V2ConversationFrameSink,
} from './resumable-chat-hub.js';
import type { WsTicketStore } from './ws-ticket-store.js';

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
  swarmCoordinator?: {
    cancelTurn(agentId: string, conversationId: string): boolean | Promise<boolean>;
  };
  /** Shared process/agent/conversation generation fence. */
  admission?: GatewayAdmissionController;
  /**
   * Single-use ticket store for browser WebSocket upgrades. Browsers cannot
   * set an `Authorization` header on a WebSocket handshake, so a caller that
   * exposes `/ws/chat` to browser clients mints short-lived tickets via HTTP
   * (`POST /mobile/v1/ws-ticket`, see `lan-mobile-app.ts`) and passes the same
   * store instance here. A ticket is only ever considered when no
   * `Authorization` header is present — see the upgrade handler below.
   */
  wsTickets?: WsTicketStore;
}

export interface ChatWsLifecycle {
  beginClosing(code: number, reason: string): void;
  flushAndCloseAll(code: number, reason: string, timeoutMs: number): Promise<void>;
}

const KNOWN_CLIENT_FRAME_TYPES = new Set(['message', 'resume', 'answer', 'cancel']);
const V2_ONLY_CLIENT_FRAME_TYPES = new Set([
  'subscribe_conversation',
  'enqueue_input',
  'edit_follow_up',
  'remove_follow_up',
  'resume_follow_ups',
]);
type ConnectionMode = 'pending' | 'v1' | 'v2' | 'closing';
type ProtocolCloseReason =
  | 'unsupported_version'
  | 'unexpected_hello'
  | 'hello_required'
  | 'invalid_frame';
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
  'location',
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
  // Presence only, NEVER values: a precise location is the most sensitive
  // thing on this frame and verbose logs are not the place for coordinates.
  if (record.location !== null && typeof record.location === 'object') {
    summary.hasLocation = true;
    const location = record.location as Record<string, unknown>;
    summary.hasPreciseLocation = location.precise !== null && typeof location.precise === 'object';
  }
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
  msg: WsServerMessage | MobileWsServerFrame | MobileV2WsServerFrame,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { frameType: msg.type };
  if ('id' in msg && typeof msg.id === 'string') summary.idLength = msg.id.length;
  if ('seq' in msg && typeof msg.seq === 'number') summary.seq = msg.seq;
  if ('v2Seq' in msg && typeof msg.v2Seq === 'number') summary.v2Seq = msg.v2Seq;
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

interface MountedChatSocket {
  close(code: number, reason: string): void;
}

export function mountChatWs<E extends Env>(app: Hono<E>, options: ChatWsOptions): ChatWsLifecycle {
  const {
    agents,
    resumableChatHub,
    upgradeWebSocket,
    verbose = false,
    eventLogStore,
    wsTickets,
  } = options;
  const admission = options.admission ?? new GatewayAdmissionController();
  const sockets = new Set<MountedChatSocket>();
  const emptyWaiters = new Set<() => void>();
  const pendingSettlements = new Set<Promise<unknown>>();
  let closing: { code: number; reason: string } | undefined;

  const notifyIfSettled = (): void => {
    if (sockets.size !== 0 || pendingSettlements.size !== 0) return;
    for (const resolve of emptyWaiters) resolve();
    emptyWaiters.clear();
  };

  const trackSettlement = <T>(promise: Promise<T>): Promise<T> => {
    pendingSettlements.add(promise);
    void promise.then(
      () => {
        pendingSettlements.delete(promise);
        notifyIfSettled();
      },
      () => {
        pendingSettlements.delete(promise);
        notifyIfSettled();
      },
    );
    return promise;
  };

  const beginClosing = (code: number, reason: string): void => {
    closing ??= { code, reason };
  };

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
    msg: WsServerMessage | MobileWsServerFrame | MobileV2WsServerFrame,
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
    shouldReply: () => boolean = () => true,
  ): void => {
    const reply = (error: unknown): void => {
      if (!shouldReply()) return;
      try {
        sendHubError(ws, id, conversationId, error);
      } catch {
        // The transport can disappear before onClose. Never turn an attempted
        // error reply into a second, unhandled dispatch rejection.
      }
    };
    try {
      void Promise.resolve(operation()).catch(reply);
    } catch (error) {
      reply(error);
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
        // An empty header is "no header": both guards below must agree on that,
        // or an `Authorization: ` sent by a proxy would take the header branch
        // (rejecting) AFTER the ticket fallback had already redeemed — burning
        // a single-use ticket on a request that was never going to succeed.
        const headerPresent = authorization !== undefined && authorization !== '';
        // Browsers also can't set headers at all, so a single-use ticket
        // (minted over HTTP, see WsTicketStore) is a second query-string
        // fallback — but ONLY when no Authorization header was sent. A
        // request carrying both a header and a ticket is judged on the
        // header alone; the ticket is left unredeemed in that case.
        const ticket = c.req.query('ticket');
        const ticketOk =
          !headerPresent && ticket !== undefined && wsTickets?.redeem(ticket) === true;
        const authorized = headerPresent
          ? authorization === `Bearer ${options.token}`
          : c.req.query('token') === options.token || ticketOk;
        if (!authorized) {
          return {
            onOpen(_event, ws) {
              ws.close(4001, 'Unauthorized');
            },
          };
        }
      }

      if (closing) {
        const closeState = closing;
        return {
          onOpen(_event, ws) {
            ws.close(closeState.code, closeState.reason);
          },
        };
      }

      // Track active streams by message ID
      const activeStreams = new Map<
        string,
        {
          controller: AbortController;
          agentId: string;
          conversationId: string;
          lease: AdmissionLease;
        }
      >();
      // Track active streams by conversation key for steer/followUp detection
      const conversationStreams = new Map<string, string>(); // convKey → messageId
      const knownRunOwners = new Map<string, { agentId: string; conversationId: string }>();
      const conversationOwners = new Map<string, string>();
      let mode: ConnectionMode = 'pending';
      let connectionSocket: { send(data: string): void } | undefined;
      let mountedSocket: MountedChatSocket | undefined;
      let cleaned = false;
      const connectionSink = {
        send(frame: MobileWsServerFrame | MobileV2WsServerFrame) {
          if (mode === 'closing' || !connectionSocket) {
            throw new Error('Chat WebSocket is not open');
          }
          sendServerMessage(connectionSocket, frame);
        },
      };
      const sink = connectionSink as TurnFrameSink;
      const v2Sink = connectionSink as V2ConversationFrameSink;

      const cancelSwarm = (agentId: string, conversationId: string): Promise<void> => {
        const result = options.swarmCoordinator?.cancelTurn(agentId, conversationId);
        if (result === undefined) return Promise.resolve();
        return Promise.resolve(result).then(() => undefined);
      };

      const cleanupConnection = (): void => {
        if (cleaned) return;
        cleaned = true;
        mode = 'closing';
        connectionSocket = undefined;
        resumableChatHub.detach(connectionSink);
        for (const { controller, agentId, conversationId } of activeStreams.values()) {
          controller.abort();
          agents.cancel(agentId, conversationId);
          trackSettlement(cancelSwarm(agentId, conversationId).catch(() => undefined));
        }
        activeStreams.clear();
        conversationStreams.clear();
        knownRunOwners.clear();
        conversationOwners.clear();
      };

      const assertFrameAdmitted = (agentId?: string, conversationId?: string): void => {
        admission.capture(agentId, conversationId);
      };

      const runAdmitted = <T>(
        agentId: string | undefined,
        conversationId: string | undefined,
        operation: () => T,
      ): T => {
        assertFrameAdmitted(agentId, conversationId);
        return operation();
      };

      const closeProtocol = (
        ws: { close(code?: number, reason?: string): void },
        reason: ProtocolCloseReason,
      ): void => {
        if (mode === 'closing') return;
        mode = 'closing';
        connectionSocket = undefined;
        ws.close(1002, reason);
      };

      const canReply = (): boolean => mode !== 'closing' && connectionSocket !== undefined;

      const sendV2CommandError = (
        ws: { send(data: string): void },
        id: string,
        conversationId: string | undefined,
        error: unknown,
      ): void => {
        if (!canReply()) return;
        if (!(error instanceof ConversationServiceError)) {
          console.error('[chat-ws] v2 dispatch failed', summarizeErrorForLog(error));
        }
        const mapped = toMobileApiError(error);
        sendServerMessage(ws, {
          type: 'command_rejected',
          id,
          ...(conversationId !== undefined ? { conversationId } : {}),
          code: mapped.body.code,
          error: mapped.body.error,
          retryable: mapped.body.retryable,
          ...(mapped.body.details !== undefined ? { details: mapped.body.details } : {}),
        });
      };

      const dispatchV2Hub = (
        ws: { send(data: string): void },
        id: string,
        conversationId: string | undefined,
        operation: () => void | Promise<void>,
      ): void => {
        const reply = (error: unknown): void => {
          try {
            sendV2CommandError(ws, id, conversationId, error);
          } catch {
            // A failed socket write must not escape a Promise rejection handler.
          }
        };
        try {
          void Promise.resolve(operation()).catch(reply);
        } catch (error) {
          reply(error);
        }
      };

      return {
        onOpen(_event, ws) {
          if (closing) {
            cleanupConnection();
            ws.close(closing.code, closing.reason);
            return;
          }
          if (mode === 'closing') return;
          connectionSocket = ws;
          mountedSocket = {
            close(code, reason) {
              cleanupConnection();
              ws.close(code, reason);
            },
          };
          sockets.add(mountedSocket);
        },

        onMessage(event, ws) {
          if (mode === 'closing') return;
          connectionSocket = ws;
          const raw = typeof event.data === 'string' ? event.data : '';
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            if (mode === 'v2') {
              if (verbose) {
                console.log(
                  '[chat-ws] ← invalid v2 JSON',
                  JSON.stringify(summarizeMobileV2Inbound(raw, undefined)),
                );
              }
              closeProtocol(ws, 'invalid_frame');
              return;
            }
            if (mode === 'pending') mode = 'v1';
            if (verbose) console.log(`[chat-ws] ← invalid JSON (${raw.length} bytes)`);
            sendServerMessage(ws, { type: 'error', id: '', error: 'Invalid JSON' });
            return;
          }

          const record =
            typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : undefined;
          const frameType = typeof record?.type === 'string' ? record.type : undefined;

          if (mode === 'pending') {
            if (frameType === 'hello') {
              if (record?.contractVersion !== 2) {
                closeProtocol(ws, 'unsupported_version');
                return;
              }
              mode = 'v2';
              const hello = parseMobileV2ClientFrame(parsed);
              if (hello.kind !== 'valid' || hello.frame.type !== 'hello') {
                closeProtocol(ws, 'invalid_frame');
                return;
              }
              if (verbose) {
                console.log(
                  '[chat-ws] ← inbound',
                  JSON.stringify(summarizeMobileV2Inbound(raw, parsed)),
                );
              }
              sendServerMessage(ws, {
                type: 'hello_ack',
                contractVersion: 2,
                capabilities: hello.frame.capabilities.filter(
                  (capability) => capability === CHAT_INPUT_QUEUE_CAPABILITY,
                ),
              });
              return;
            }
            if (frameType !== undefined && V2_ONLY_CLIENT_FRAME_TYPES.has(frameType)) {
              closeProtocol(ws, 'hello_required');
              return;
            }
            mode = 'v1';
          } else if (frameType === 'hello') {
            closeProtocol(ws, 'unexpected_hello');
            return;
          }

          if (mode === 'v2') {
            if (verbose) {
              console.log(
                '[chat-ws] ← inbound',
                JSON.stringify(summarizeMobileV2Inbound(raw, parsed)),
              );
            }
            const result = parseMobileV2ClientFrame(parsed);
            if (result.kind === 'fatal') {
              closeProtocol(ws, result.reason);
              return;
            }
            if (result.kind === 'rejectable') {
              sendServerMessage(ws, {
                type: 'command_rejected',
                id: result.id,
                ...(result.conversationId !== undefined
                  ? { conversationId: result.conversationId }
                  : {}),
                code: result.code,
                error: result.error,
                retryable: false,
              });
              return;
            }

            const msg = result.frame;
            switch (msg.type) {
              case 'subscribe_conversation': {
                conversationOwners.set(msg.conversationId, msg.agentId);
                dispatchV2Hub(ws, msg.id, msg.conversationId, () =>
                  runAdmitted(msg.agentId, msg.conversationId, () =>
                    resumableChatHub.subscribeConversation(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'message': {
                conversationOwners.set(msg.conversationId, msg.agentId);
                knownRunOwners.set(msg.id, {
                  agentId: msg.agentId,
                  conversationId: msg.conversationId,
                });
                dispatchV2Hub(ws, msg.id, msg.conversationId, () =>
                  runAdmitted(msg.agentId, msg.conversationId, () =>
                    resumableChatHub.startV2(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'enqueue_input': {
                conversationOwners.set(msg.conversationId, msg.agentId);
                if (msg.behavior === 'steer' && msg.expectedActiveTurnId !== undefined) {
                  knownRunOwners.set(msg.expectedActiveTurnId, {
                    agentId: msg.agentId,
                    conversationId: msg.conversationId,
                  });
                }
                dispatchV2Hub(ws, msg.id, msg.conversationId, () =>
                  runAdmitted(msg.agentId, msg.conversationId, () =>
                    resumableChatHub.enqueueInput(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'edit_follow_up': {
                const agentId = conversationOwners.get(msg.conversationId);
                dispatchV2Hub(ws, msg.id, msg.conversationId, () =>
                  runAdmitted(agentId, msg.conversationId, () =>
                    resumableChatHub.editFollowUp(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'remove_follow_up': {
                const agentId = conversationOwners.get(msg.conversationId);
                dispatchV2Hub(ws, msg.id, msg.conversationId, () =>
                  runAdmitted(agentId, msg.conversationId, () =>
                    resumableChatHub.removeFollowUp(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'resume_follow_ups': {
                const agentId = conversationOwners.get(msg.conversationId);
                dispatchV2Hub(ws, msg.id, msg.conversationId, () =>
                  runAdmitted(agentId, msg.conversationId, () =>
                    resumableChatHub.resumeFollowUps(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'answer': {
                const owner = knownRunOwners.get(msg.id);
                dispatchV2Hub(ws, msg.id, undefined, () =>
                  runAdmitted(owner?.agentId, owner?.conversationId, () =>
                    resumableChatHub.answerV2(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'cancel': {
                const owner = knownRunOwners.get(msg.id);
                dispatchV2Hub(ws, msg.id, undefined, () =>
                  runAdmitted(owner?.agentId, owner?.conversationId, () =>
                    resumableChatHub.cancelV2(msg, v2Sink),
                  ),
                );
                return;
              }
              case 'hello':
                closeProtocol(ws, 'unexpected_hello');
                return;
            }
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
            conversationOwners.set(msg.conversationId, msg.agentId);
            knownRunOwners.set(msg.id, {
              agentId: msg.agentId,
              conversationId: msg.conversationId,
            });
            dispatchHub(
              ws,
              msg.id,
              msg.conversationId,
              () =>
                runAdmitted(msg.agentId, msg.conversationId, () =>
                  resumableChatHub.resume(msg, sink),
                ),
              canReply,
            );
            return;
          }

          if (msg.type === 'answer') {
            const entry = activeStreams.get(msg.id);
            if (entry) {
              dispatchHub(
                ws,
                msg.id,
                undefined,
                async () => {
                  const lease = admission.acquire(entry.agentId, entry.conversationId);
                  try {
                    await agents.answerQuestion(
                      entry.agentId,
                      entry.conversationId,
                      msg.questionId,
                      msg.answer,
                    );
                  } finally {
                    lease.release();
                  }
                },
                canReply,
              );
            } else {
              const owner = knownRunOwners.get(msg.id);
              dispatchHub(
                ws,
                msg.id,
                undefined,
                () =>
                  runAdmitted(owner?.agentId, owner?.conversationId, () =>
                    resumableChatHub.answer(msg.id, msg.questionId, msg.answer, sink),
                  ),
                canReply,
              );
            }
            return;
          }

          if (msg.type === 'cancel') {
            const entry = activeStreams.get(msg.id);
            if (entry) {
              dispatchHub(
                ws,
                msg.id,
                entry.conversationId,
                () => {
                  assertFrameAdmitted(entry.agentId, entry.conversationId);
                  entry.controller.abort();
                  activeStreams.delete(msg.id);
                  const key = conversationKey(entry.agentId, entry.conversationId);
                  if (conversationStreams.get(key) === msg.id) conversationStreams.delete(key);
                  agents.cancel(entry.agentId, entry.conversationId);
                  const cancellation = options.swarmCoordinator?.cancelTurn(
                    entry.agentId,
                    entry.conversationId,
                  );
                  if (cancellation && typeof cancellation === 'object' && 'then' in cancellation) {
                    return Promise.resolve(cancellation).then(() => {
                      if (canReply()) sendServerMessage(ws, { type: 'done', id: msg.id });
                    });
                  }
                  if (canReply()) sendServerMessage(ws, { type: 'done', id: msg.id });
                },
                canReply,
              );
            } else {
              const owner = knownRunOwners.get(msg.id);
              dispatchHub(
                ws,
                msg.id,
                undefined,
                () =>
                  runAdmitted(owner?.agentId, owner?.conversationId, () =>
                    resumableChatHub.cancel(msg.id, sink),
                  ),
                canReply,
              );
            }
            return;
          }

          if (msg.type === 'message') {
            conversationOwners.set(msg.conversationId, msg.agentId);
            knownRunOwners.set(msg.id, {
              agentId: msg.agentId,
              conversationId: msg.conversationId,
            });
            if (msg.resumable === true) {
              dispatchHub(
                ws,
                msg.id,
                msg.conversationId,
                () =>
                  runAdmitted(msg.agentId, msg.conversationId, () =>
                    resumableChatHub.start(msg as ResumableSendFrame, sink),
                  ),
                canReply,
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
                const lease = admission.acquire(agentId, convId);
                void trackSettlement(
                  agents.steer(agentId, convId, text, images).finally(() => lease.release()),
                ).catch((err) => {
                  sendServerMessage(ws, {
                    type: 'error',
                    id: msg.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
                return;
              }
              if (behavior === 'followUp') {
                const lease = admission.acquire(agentId, convId);
                void trackSettlement(
                  agents.followUp(agentId, convId, text, images).finally(() => lease.release()),
                ).catch((err) => {
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
            let lease: AdmissionLease;
            try {
              lease = admission.acquire(agentId, convId);
            } catch (error) {
              sendHubError(ws, msg.id, convId, error);
              return;
            }
            activeStreams.set(msg.id, { controller, agentId, conversationId: convId, lease });
            conversationStreams.set(convKey, msg.id);

            const streamTask = (async () => {
              const stream = agents.chat({
                agentId,
                conversationId: convId,
                channelId,
                text,
                images: images?.length ? images : undefined,
                location: toClientLocation(msg.location),
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
                try {
                  await stream.return(undefined);
                } finally {
                  lease.release();
                }
              }
            })();
            void trackSettlement(streamTask).catch(() => undefined);
          }
        },

        onClose() {
          cleanupConnection();
          if (mountedSocket) sockets.delete(mountedSocket);
          mountedSocket = undefined;
          notifyIfSettled();
        },
      };
    }),
  );

  return {
    beginClosing,
    async flushAndCloseAll(code, reason, timeoutMs) {
      beginClosing(code, reason);
      const closeState = closing;
      if (!closeState) return;
      for (const socket of sockets) {
        try {
          socket.close(closeState.code, closeState.reason);
        } catch {
          sockets.delete(socket);
        }
      }
      notifyIfSettled();
      if (sockets.size === 0 && pendingSettlements.size === 0) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          emptyWaiters.delete(done);
          resolve();
        };
        const timeout = setTimeout(done, Math.max(0, timeoutMs));
        emptyWaiters.add(done);
        notifyIfSettled();
      });
    },
  };
}
