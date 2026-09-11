import type { AgentEvent, ImageBlock } from '@dash/agent';
import type { MobileWsClientFrame, MobileWsServerFrame } from '@dash/mobile-contract';
import {
  type SpeechService,
  type VoiceServerFrame,
  VoiceSession,
  type VoiceStopReason,
} from '@dash/speech';
import { isTransientAgentEvent } from '@dash/swarm';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { toClientLocation } from './client-location.js';
import { toMobileApiError } from './conversation-routes.js';
import { ConversationServiceError } from './conversation-service.js';
import type { EventLogStore } from './event-log-store.js';
import type { ResumableChatHub, ResumableSendFrame, TurnFrameSink } from './resumable-chat-hub.js';
import { createVoiceTurnBridge, withTranscriptionDeadline } from './voice-bridge.js';
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
  swarmCoordinator?: { cancelTurn(agentId: string, conversationId: string): boolean };
  /**
   * Speech provider for the hands-free voice mode. Absent (or unavailable at
   * `voice_start` time) answers every `voice_start` with
   * `voice_error { code: 'unavailable' }` — the socket still serves ordinary
   * chat, so a gateway with no speech credential is not a broken gateway.
   */
  speech?: SpeechService;
  /**
   * Conversation lookup, used ONLY to reject a `voice_start` naming a
   * conversation that does not exist or belongs to another agent. Structural
   * (the hub's own `assertOwnedConversation` check) so tests can pass a stub;
   * omitted, the check is skipped and the hub rejects the first turn instead.
   */
  conversations?: { get(id: string): { agentId: string } | null };
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

const KNOWN_CLIENT_FRAME_TYPES = new Set([
  'message',
  'resume',
  'answer',
  'cancel',
  'subscribe',
  'unsubscribe',
  'voice_start',
  'voice_audio',
  'voice_mute',
  'voice_stop',
]);
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
  'modality',
  'seq',
  'muted',
  // NOTE: 'pcm' is deliberately absent. Audio bytes never reach a log line —
  // the summary below records only that a frame carried pcm, and how much.
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
  if (typeof record.seq === 'number') summary.seq = record.seq;
  if (typeof record.muted === 'boolean') summary.muted = record.muted;
  // Presence and size only: a `voice_audio` frame is the user's microphone.
  if (typeof record.pcm === 'string') {
    summary.hasPcm = true;
    summary.pcmBytes = Buffer.from(record.pcm, 'base64').byteLength;
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
  msg: WsServerMessage | MobileWsServerFrame | VoiceServerFrame,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { frameType: msg.type };
  if (typeof msg.id === 'string') summary.idLength = msg.id.length;
  if ('seq' in msg && typeof msg.seq === 'number') summary.seq = msg.seq;
  if (msg.type === 'event') summary.eventType = msg.event?.type ?? 'unknown';
  // A voice frame's `audio` is never summarized, by construction: this
  // function only ever copies the fields it names.
  if (msg.type === 'voice_state') summary.state = msg.state;
  if (msg.type === 'voice_stopped') summary.reason = msg.reason;
  if (msg.type === 'voice_transcript') summary.textLength = msg.text.length;
  if (msg.type === 'voice_error') {
    summary.errorCode = msg.code;
    summary.errorMessageLength = msg.error.length;
  }
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

/**
 * The hands-free voice client frames now live in `contracts/mobile/v1`
 * (`MobileWsClientFrame`'s `voice_start` | `voice_audio` | `voice_mute` |
 * `voice_stop` variants) alongside the rest of the chat wire protocol. This
 * alias is kept only so existing imports (`chat-ws.test.ts`) do not need to
 * change name; it is exactly `Extract<MobileWsClientFrame, {type: 'voice_*'}>`.
 */
export type VoiceClientFrame = Extract<
  MobileWsClientFrame,
  { type: 'voice_start' | 'voice_audio' | 'voice_mute' | 'voice_stop' }
>;

export type ChatClientFrame = MobileWsClientFrame;

// Compile-time proof that `@dash/speech`'s `VoiceServerFrame` — the actual
// producer of every `voice_*` server frame — is structurally assignable to
// the contract's `MobileWsServerFrame`. `@dash/speech` is the SOURCE of the
// shape (VoiceSession authors the frames); the contract restates it so a
// client depends on the frozen wire type rather than the server package, and
// this assertion is what keeps the restatement honest. It only actually
// type-checks where a gate runs `tsc`/emits `.d.ts` for this file (tsup's
// `dts: true` build here) — vitest's esbuild transform does not check types.
type _VoiceServerFrameAssignableToContract = VoiceServerFrame extends MobileWsServerFrame
  ? true
  : never;
const _voiceServerFrameAssignableToContract: _VoiceServerFrameAssignableToContract = true;
void _voiceServerFrameAssignableToContract;

/**
 * One capture frame from the phone. 16 KB is 512ms of 16 kHz mono PCM16 — far
 * more than the ~20-100ms chunks the client sends, and small enough that a
 * flood of them cannot be used to buffer megabytes per socket.
 */
const MAX_VOICE_PCM_BYTES = 16 * 1024;

export function parseChatClientFrame(msg: unknown): ChatClientFrame | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.type !== 'string') return null;

  if (m.type === 'cancel') return msg as MobileWsClientFrame;

  if (m.type === 'answer') {
    if (typeof m.questionId !== 'string' || typeof m.answer !== 'string') return null;
    return msg as MobileWsClientFrame;
  }

  if (m.type === 'subscribe' || m.type === 'unsubscribe') {
    if (
      typeof m.agentId !== 'string' ||
      typeof m.conversationId !== 'string' ||
      !isValidConversationId(m.conversationId)
    ) {
      return null;
    }
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

  if (m.type === 'voice_start') {
    if (
      typeof m.agentId !== 'string' ||
      typeof m.conversationId !== 'string' ||
      !isValidConversationId(m.conversationId)
    ) {
      return null;
    }
    return msg as VoiceClientFrame;
  }

  if (m.type === 'voice_audio') {
    if (typeof m.pcm !== 'string') return null;
    if (!Number.isInteger(m.seq) || (m.seq as number) < 0) return null;
    const bytes = decodedBase64Bytes(m.pcm);
    if (bytes < 0 || bytes > MAX_VOICE_PCM_BYTES) return null;
    return msg as VoiceClientFrame;
  }

  if (m.type === 'voice_mute') {
    if (typeof m.muted !== 'boolean') return null;
    return msg as VoiceClientFrame;
  }

  if (m.type === 'voice_stop') return msg as VoiceClientFrame;

  if (m.type === 'message') {
    const valid =
      typeof m.agentId === 'string' &&
      typeof m.channelId === 'string' &&
      typeof m.conversationId === 'string' &&
      typeof m.text === 'string';
    if (!valid) return null;
    if (!isValidConversationId(m.conversationId as string)) return null;
    if (m.resumable !== undefined && typeof m.resumable !== 'boolean') return null;
    if (m.modality !== undefined && m.modality !== 'text' && m.modality !== 'voice') return null;
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

/** The one voice session a socket may hold, plus the hub sink it runs turns on. */
interface VoiceSlot {
  sink: TurnFrameSink;
  /**
   * Installed once `speech.available()` has resolved true — a `voice_audio`
   * that arrives before then is dropped, not rejected, since the phone starts
   * streaming the moment it sends `voice_start`.
   */
  session?: VoiceSession;
}

function conversationKey(agentId: string, conversationId: string): string {
  return `${agentId}/${conversationId}`;
}

export function mountChatWs(app: Hono, options: ChatWsOptions): void {
  const {
    agents,
    resumableChatHub,
    upgradeWebSocket,
    verbose = false,
    eventLogStore,
    wsTickets,
  } = options;

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
    msg: WsServerMessage | MobileWsServerFrame | VoiceServerFrame,
  ): void => {
    const payload = JSON.stringify(msg, (_key, value) =>
      value instanceof Error ? value.message : value,
    );
    if (verbose) {
      console.log('[chat-ws] → outbound', JSON.stringify(summarizeOutboundForLog(msg)));
    }
    ws.send(payload);
  };

  /** A hub failure as the client's error frame. Logs the failure without its text. */
  const hubErrorFrame = (
    id: string,
    conversationId: string | undefined,
    error: unknown,
  ): MobileWsServerFrame => {
    if (!(error instanceof ConversationServiceError)) {
      console.error('[chat-ws] resumable dispatch failed', summarizeErrorForLog(error));
    }
    const mapped = toMobileApiError(error);
    const activeTurnId = mapped.body.details?.activeTurnId;
    return {
      type: 'error',
      id,
      ...(conversationId !== undefined ? { conversationId } : {}),
      error: mapped.body.error,
      code: mapped.body.code,
      retryable: mapped.body.retryable,
      ...(typeof activeTurnId === 'string' ? { activeTurnId } : {}),
    };
  };

  const sendHubError = (
    ws: { send(data: string): void },
    id: string,
    conversationId: string | undefined,
    error: unknown,
  ): void => {
    sendServerMessage(ws, hubErrorFrame(id, conversationId, error));
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

      /** One voice session per socket: a second `voice_start` replaces the first. */
      let voice: VoiceSlot | undefined;

      /**
       * Best-effort frame sink for the session. Unlike the hub's `sink` above
       * this NEVER throws: the session emits `voice_stopped` from `stop()`,
       * which the socket's own close handler calls, and a throw there would
       * escape into the WebSocket callback.
       */
      const emitVoice = (frame: VoiceServerFrame | MobileWsServerFrame): void => {
        const ws = connectionSocket;
        if (!ws) return;
        try {
          sendServerMessage(ws, frame);
        } catch {
          // The socket went away mid-frame; `onClose` tears the session down.
        }
      };

      const stopVoice = (reason: VoiceStopReason): void => {
        const current = voice;
        voice = undefined;
        if (!current) return;
        current.session?.stop(reason);
        // The bridge's sink is the hub's, not the connection's: a conversation
        // subscription taken out by a voice turn outlives the turn itself.
        resumableChatHub.detach(current.sink);
      };

      const startVoice = (
        ws: { send(data: string): void },
        frame: Extract<VoiceClientFrame, { type: 'voice_start' }>,
      ): void => {
        stopVoice('replaced');
        const speech = options.speech;
        if (!speech) {
          sendServerMessage(ws, {
            type: 'voice_error',
            id: frame.id,
            code: 'unavailable',
            error: 'Speech is not configured on this gateway',
          });
          return;
        }
        // The same ownership check the hub makes on `start`, made here so the
        // phone learns immediately rather than after its first utterance.
        if (
          options.conversations &&
          options.conversations.get(frame.conversationId)?.agentId !== frame.agentId
        ) {
          sendServerMessage(ws, {
            type: 'voice_error',
            id: frame.id,
            code: 'invalid',
            error: 'Conversation not found',
          });
          return;
        }

        const bridge = createVoiceTurnBridge({
          hub: resumableChatHub,
          agentId: frame.agentId,
          conversationId: frame.conversationId,
          forward: emitVoice,
          errorFrame: hubErrorFrame,
        });
        const slot: VoiceSlot = { sink: bridge.sink };
        voice = slot;

        void (async () => {
          let available = false;
          try {
            available = await speech.available();
          } catch (error) {
            console.error(
              '[chat-ws] speech availability check failed',
              summarizeErrorForLog(error),
            );
          }
          // Replaced, stopped, or the socket closed while we were asking.
          if (voice !== slot) return;
          if (!available) {
            voice = undefined;
            resumableChatHub.detach(slot.sink);
            emitVoice({
              type: 'voice_error',
              id: frame.id,
              code: 'unavailable',
              error: 'No speech provider is available',
            });
            return;
          }
          slot.session = new VoiceSession({
            id: frame.id,
            speech: withTranscriptionDeadline(speech),
            driver: bridge.driver,
            emit: emitVoice,
          });
        })();
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

          if (msg.type === 'voice_start') {
            startVoice(ws, msg);
            return;
          }

          if (msg.type === 'voice_audio' || msg.type === 'voice_mute') {
            if (!voice) {
              sendServerMessage(ws, {
                type: 'voice_error',
                id: msg.id,
                code: 'invalid',
                error: 'No voice session is running',
              });
              return;
            }
            // A duplicate or out-of-order `seq` is passed through untouched:
            // the VAD consumes whatever arrives, in arrival order.
            if (msg.type === 'voice_audio') voice.session?.audio(Buffer.from(msg.pcm, 'base64'));
            else voice.session?.mute(msg.muted);
            return;
          }

          if (msg.type === 'voice_stop') {
            // Idempotent teardown: stopping a session that already ended (or
            // never started) is not worth an error frame.
            stopVoice('client');
            return;
          }

          if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
            // Bookkeeping only: no acknowledgement frame, so a client that
            // subscribes to a quiet conversation sees nothing until a turn runs.
            dispatchHub(ws, msg.id, msg.conversationId, () => {
              if (msg.type === 'subscribe') {
                resumableChatHub.subscribe(msg.agentId, msg.conversationId, sink);
              } else {
                resumableChatHub.unsubscribe(msg.agentId, msg.conversationId, sink);
              }
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
                location: toClientLocation(msg.location),
                modality: msg.modality,
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
                  // Transient events (spec §7.2) are live-stream only: broadcast
                  // but never appended, so they carry no seq and never show up
                  // in a resume replay.
                  const seq = isTransientAgentEvent(agentEvent)
                    ? undefined
                    : logPayload(agentId, convId, msg.id, {
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
          // First: a voice session must not emit into a dead socket, and a
          // `voice_start` still awaiting `available()` must not install one.
          connectionSocket = undefined;
          stopVoice('socket');
          resumableChatHub.detach(sink);
          for (const { controller, agentId, conversationId } of activeStreams.values()) {
            controller.abort();
            agents.cancel(agentId, conversationId);
            options.swarmCoordinator?.cancelTurn(agentId, conversationId);
          }
          activeStreams.clear();
          conversationStreams.clear();
        },
      };
    }),
  );
}
