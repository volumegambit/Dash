import type { AgentEvent } from '@dash/agent';
import type { MobileApiErrorCode, MobileWsServerFrame } from '@dash/mobile-contract';
import { SpeechError, type SpeechService, type TurnDriver } from '@dash/speech';
import type { ResumableChatHub, ResumableSendFrame, TurnFrameSink } from './resumable-chat-hub.js';

/**
 * A voice turn is a `/ws/chat` turn from the phone, so it carries the same
 * channel id an iOS chat turn does. Nothing keys off it beyond the transcript.
 */
const VOICE_CHANNEL_ID = 'ios';

/**
 * How long one utterance may spend in transcription before the session gives
 * up on it. `VoiceSession` serializes transcriptions, so a provider that never
 * answers would silently wedge every later utterance behind it — the user
 * keeps talking and the session never speaks again.
 */
export const TRANSCRIPTION_DEADLINE_MS = 20_000;

/**
 * Wraps a {@link SpeechService} so `transcribe` races a deadline. Everything
 * else is delegated untouched: synthesis is already bounded by the turn it
 * belongs to (a barge-in or a `stop` aborts its stream), and only the
 * transcription chain is serialized.
 */
export function withTranscriptionDeadline(
  speech: SpeechService,
  deadlineMs: number = TRANSCRIPTION_DEADLINE_MS,
): SpeechService {
  return {
    currentConfig: () => speech.currentConfig(),
    providers: () => speech.providers(),
    listModels: (kind) => speech.listModels(kind),
    synthesize: (text, format) => speech.synthesize(text, format),
    available: () => speech.available(),
    invalidate: () => speech.invalidate(),
    transcribe(audio, format, language) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new SpeechError('network', 'transcription timed out'));
        }, deadlineMs);
        // Never hold the process open on a transcription nobody is waiting for.
        timer.unref?.();
        speech.transcribe(audio, format, language).then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
  };
}

export interface VoiceTurnBridgeOptions {
  hub: ResumableChatHub;
  agentId: string;
  conversationId: string;
  /**
   * Writes a hub frame to the socket. MUST NOT throw: the sink below is the
   * hub's, and a throwing sink is dropped from the turn — losing the very
   * frames the driver needs to finish its turn.
   */
  forward(frame: MobileWsServerFrame): void;
  /** Renders a hub throw as the socket's ordinary error frame. */
  errorFrame(turnId: string, conversationId: string, error: unknown): MobileWsServerFrame;
}

export interface VoiceTurnBridge {
  driver: TurnDriver;
  /**
   * The sink the hub writes this socket's voice turns to. It is NOT the
   * socket's own connection sink — every frame still reaches the socket, but
   * the bridge has to read them on the way past — so the caller must detach
   * it from the hub when the socket closes.
   */
  sink: TurnFrameSink;
}

interface RunningTurn {
  turnId: string;
  onEvent(event: AgentEvent): void;
  onDone(
    outcome: 'completed' | 'cancelled' | 'failed',
    error?: string,
    code?: MobileApiErrorCode,
  ): void;
}

/**
 * The {@link TurnDriver} a {@link VoiceSession} runs its turns through: a
 * spoken turn IS an ordinary resumable chat turn (`modality: 'voice'`), so it
 * persists, replays, auto-titles and can be resumed from another device
 * exactly like a typed one.
 *
 * The sink is a tee. Every frame the hub produces is forwarded to the socket
 * untouched — the phone keeps its normal transcript — and the frames of the
 * turn the session is currently running are ALSO fed back to the session, so
 * it can speak the reply as it streams.
 */
export function createVoiceTurnBridge(options: VoiceTurnBridgeOptions): VoiceTurnBridge {
  const { hub, agentId, conversationId } = options;
  let running: RunningTurn | null = null;

  const sink: TurnFrameSink = {
    send(frame) {
      options.forward(frame);
      const turn = running;
      // Only the session's own turn is routed. A subscribed conversation can
      // deliver frames for a notification turn or another device's turn, and
      // the session must not speak those.
      if (!turn || frame.id !== turn.turnId) return;
      if (frame.type === 'event') {
        turn.onEvent(frame.event as AgentEvent);
        return;
      }
      if (frame.type === 'done') {
        running = null;
        // `outcome` is optional on the wire and absent means completed.
        turn.onDone(frame.outcome === 'cancelled' ? 'cancelled' : 'completed');
        return;
      }
      if (frame.type === 'error') {
        running = null;
        // F4: the hub's own code travels with the failure. `conversation_busy`
        // (a turn already running on this conversation — routine with two
        // devices), `not_found` and `unauthorized` describe the CONVERSATION,
        // not this turn, so the session ends rather than looping the same
        // `voice_error { provider }` on every later utterance.
        turn.onDone('failed', frame.error, frame.code);
      }
    },
  };

  const driver: TurnDriver = {
    start(turnId, text, onEvent, onDone) {
      running = { turnId, onEvent, onDone };
      const frame: ResumableSendFrame = {
        type: 'message',
        id: turnId,
        agentId,
        channelId: VOICE_CHANNEL_ID,
        conversationId,
        text,
        resumable: true,
        modality: 'voice',
      };
      try {
        hub.start(frame, sink);
      } catch (error) {
        // A hub throw (an unknown conversation, a stopped hub, a busy
        // conversation) is reported through the same tee a real failure takes,
        // so the socket gets the ordinary error frame and the session learns
        // the turn failed in exactly one place. Deferred by a microtask: the
        // session is still inside `startTurn` and has yet to announce the
        // turn's `thinking` state, which a synchronous `onDone` would leave
        // stuck on a turn that is already over.
        queueMicrotask(() => sink.send(options.errorFrame(turnId, conversationId, error)));
      } finally {
        // Starting a turn also subscribes its sink to the CONVERSATION, for
        // the whole socket's lifetime (hub spec 7.6). This sink must not keep
        // that: the socket's own connection sink is already subscribed
        // whenever the client is looking at this conversation, and the hub
        // fans a notification / sub-agent turn out to every subscriber — so
        // leaving both attached would write those frames to the socket twice.
        // The turn's own frames are unaffected: they go to `live.subscribers`,
        // which this sink stays in until the turn ends.
        hub.unsubscribe(agentId, conversationId, sink);
      }
    },

    answer(turnId, questionId, answer) {
      return hub.answer(turnId, questionId, answer);
    },

    cancel(turnId) {
      return hub.cancel(turnId, sink);
    },
  };

  return { driver, sink };
}
