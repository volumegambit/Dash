import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@dash/agent';
import type { MobileApiErrorCode } from '@dash/mobile-contract';
import { SpeechError, type SpeechErrorCode } from './errors.js';
import type { SpeechService } from './service.js';
import { type SpeechItem, SpokenRenderer } from './spoken-renderer.js';
import { VoiceActivityDetector } from './vad.js';
import { wavFromPcm16 } from './wav.js';

/** The phone streams 16 kHz mono PCM16; the VAD's utterance `pcm` is in that rate. */
const CAPTURE_SAMPLE_RATE = 16000;
/** VAD confirmation window while the session is not speaking. */
const LISTENING_START_MS = 300;
/** Wider confirmation window while speaking, so the TTS output itself can't trip a barge-in. */
const SPEAKING_START_MS = 400;
/** A barge-in only counts once the session has been speaking for this long. */
const BARGE_IN_GUARD_MS = 300;
/**
 * How long the session waits for the phone's `voice_played` acknowledgement
 * before giving up on it and returning to `listening` anyway. A client that
 * never sends one (an older build, a dropped frame) must not strand the
 * session in `speaking` with a live microphone it refuses to act on.
 */
const DRAIN_TIMEOUT_MS = 8000;
/**
 * Consecutive synthesis failures tolerated before the session gives up. A
 * retryable code (`unavailable`, `network`) costs the sentence and nothing
 * more; three in a row is a provider outage, which the spec does sanction
 * ending the session for.
 */
const MAX_CONSECUTIVE_SYNTHESIS_FAILURES = 3;
/** Hub codes a voice session can never recover from by trying the turn again. */
const FATAL_HUB_CODES: Partial<Record<MobileApiErrorCode, SpeechErrorCode>> = {
  conversation_busy: 'unavailable',
  not_found: 'invalid',
  unauthorized: 'invalid',
};

export type VoiceState =
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'stopped';

export type VoiceStopReason = 'client' | 'socket' | 'provider' | 'replaced';

export type VoiceServerFrame =
  | { type: 'voice_state'; id: string; state: VoiceState; turnId?: string }
  | {
      type: 'voice_transcript';
      id: string;
      text: string;
      final: boolean;
      /** Set on the final transcript that starts a turn; ALWAYS emitted before the hub's `accepted`. */
      turnId?: string;
    }
  | {
      type: 'voice_speech';
      id: string;
      seq: number;
      /** base64 of the chunk's bytes. */
      audio: string;
      format: 'pcm16' | 'mp3';
      sampleRate?: number;
      text: string;
    }
  | { type: 'voice_error'; id: string; code: SpeechErrorCode; error: string }
  | { type: 'voice_stopped'; id: string; reason: VoiceStopReason };

export interface TurnDriver {
  /**
   * `turnId` is chosen by the SESSION (randomUUID) and becomes the hub message
   * frame's `id`, so the phone can key its optimistic row on it before
   * `accepted` arrives.
   */
  start(
    turnId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
    onDone: (
      outcome: 'completed' | 'cancelled' | 'failed',
      error?: string,
      /**
       * The hub's own `MobileApiErrorCode` for a `failed` outcome, when the
       * driver knows it. `conversation_busy` / `not_found` / `unauthorized`
       * mean the session can never run a turn on this conversation, so the
       * session ends rather than looping the same error per utterance (F4).
       */
      code?: MobileApiErrorCode,
    ) => void,
  ): void;
  answer(turnId: string, questionId: string, answer: string): Promise<void>;
  cancel(turnId: string): Promise<void>;
}

export interface VoiceSessionOptions {
  id: string;
  speech: SpeechService;
  driver: TurnDriver;
  emit: (frame: VoiceServerFrame) => void;
  vad?: VoiceActivityDetector;
  /**
   * Builds the renderer for a turn. A renderer covers exactly ONE turn (it
   * suppresses repeat error statuses and tracks tool-status bursts for its
   * lifetime), so this is a factory, not an instance. Defaults to
   * `() => new SpokenRenderer({ now })`.
   */
  renderer?: () => SpokenRenderer;
  now?: () => number;
  /** Injectable so tests get deterministic turn ids. Defaults to `randomUUID`. */
  newTurnId?: () => string;
  /**
   * How long to wait for the phone's `voice_played` acknowledgement before
   * returning to `listening` regardless. Defaults to {@link DRAIN_TIMEOUT_MS}.
   */
  drainTimeoutMs?: number;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

interface Turn {
  id: string;
  renderer: SpokenRenderer;
  /** The driver has called `onDone` — no `cancel` is owed and the queue may drain to `listening`. */
  done: boolean;
  /** Set when the turn ended `failed`; reported once its speech has drained. */
  failure?: string;
  /**
   * At least one `voice_speech` was emitted for this turn. The drain gate is
   * skipped entirely when nothing was spoken — `seq` is session-monotonic and
   * never reset, so the emitted high-water mark alone cannot say whether THIS
   * turn put anything on the wire.
   */
  spoke: boolean;
}

interface QueuedItem {
  turn: Turn;
  item: SpeechItem;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The hands-free voice conversation: PCM in, `voice_*` frames out.
 *
 * It owns one VAD, one agent turn at a time and one serialized synthesis
 * queue, and it is the only thing that knows the voice state machine:
 *
 * ```
 * listening --speech_end--> transcribing --transcript--> thinking
 *                              |                            |
 *                              |                     first audio chunk
 *                              v                            v
 *                          listening <---turn done + queue drained--- speaking
 * ```
 *
 * `muted` and `stopped` cut across all of it: `muted` drops incoming audio
 * (playback continues) and `stopped` is terminal and idempotent.
 *
 * Two orderings are load-bearing and covered by tests:
 * 1. the `voice_transcript` carrying `turnId` is emitted BEFORE `driver.start`,
 *    because the phone dispatches its optimistic user row from that frame and
 *    an `accepted` for a turn it did not start renders as another device's;
 * 2. `voice_state speaking` precedes the first `voice_speech` of a turn.
 *
 * The session never logs: audio bytes and transcripts must not reach a console
 * line, and no thrown error message carries them.
 */
export class VoiceSession {
  private readonly id: string;
  private readonly speech: SpeechService;
  private readonly driver: TurnDriver;
  private readonly emitFrame: (frame: VoiceServerFrame) => void;
  private readonly vad: VoiceActivityDetector;
  private readonly now: () => number;
  private readonly newTurnId: () => string;

  private readonly newRenderer: () => SpokenRenderer;
  private innerState: VoiceState = 'listening';
  private muted = false;
  private isStopped = false;

  private turn: Turn | null = null;
  private pendingQuestion: { turnId: string; questionId: string } | null = null;
  /** Transcripts captured while a turn was running, in utterance order (FIFO). */
  private queuedTranscripts: string[] = [];
  /**
   * Utterances are transcribed one at a time, in the order they were spoken:
   * concurrent transcriptions would let a short clip's result overtake a long
   * one's and start the turns in the wrong order.
   */
  private transcribeChain: Promise<void> = Promise.resolve();
  /** Bumped by a barge-in; a transcription from an older generation is discarded. */
  private utteranceGeneration = 0;

  private queue: QueuedItem[] = [];
  private synthesizing = false;
  /** Bumped by every abort; a synthesis whose generation is stale drops its output. */
  private generation = 0;
  private activeIterator: AsyncIterator<Uint8Array> | null = null;
  private seq = 0;
  private speakingSince: number | null = null;
  /** The highest `seq` put on the wire, or -1 before the first chunk. */
  private lastEmittedSeq = -1;
  /** The highest `seq` the phone says it has finished playing. */
  private lastPlayedSeq = -1;
  /** Armed while the session is holding `speaking` for the phone to drain. */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly drainTimeoutMs: number;
  /** Synthesis failures since the last sentence that spoke (F3). */
  private consecutiveSynthesisFailures = 0;

  constructor(options: VoiceSessionOptions) {
    this.id = options.id;
    this.speech = options.speech;
    this.driver = options.driver;
    this.emitFrame = options.emit;
    this.vad = options.vad ?? new VoiceActivityDetector();
    this.now = options.now ?? Date.now;
    this.newTurnId = options.newTurnId ?? (() => randomUUID());
    this.newRenderer = options.renderer ?? (() => new SpokenRenderer({ now: this.now }));
    this.drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;

    this.emit({ type: 'voice_state', state: 'listening' });
  }

  get state(): VoiceState {
    if (this.isStopped) return 'stopped';
    if (this.muted) return 'muted';
    return this.innerState;
  }

  /** Feeds one PCM16 frame from the phone. Dropped entirely while muted or stopped. */
  audio(pcm: Uint8Array): void {
    if (this.isStopped || this.muted) return;
    for (const event of this.vad.push(pcm)) {
      if (event.type === 'speech_start') this.onSpeechStart();
      else if (event.type === 'speech_end') this.enqueueUtterance(event.pcm);
    }
  }

  /**
   * Mutes the microphone. Audio is dropped before the VAD, so a muted stretch
   * never becomes an utterance; playback is unaffected. Unmuting re-announces
   * whatever state the session reached while muted.
   */
  mute(muted: boolean): void {
    if (this.isStopped || muted === this.muted) return;
    this.muted = muted;
    if (muted) {
      this.emitFrame({ type: 'voice_state', id: this.id, state: 'muted' });
      return;
    }
    this.emitState(this.innerState);
  }

  /**
   * The phone has finished PLAYING every `voice_speech` up to and including
   * `seq` (F1). Until this arrives the session stays `speaking`, because the
   * client flushes playback the moment it leaves that state — announcing
   * `listening` while the speaker is still going truncated every reply's tail.
   *
   * A stale or out-of-order `seq` only ever raises the high-water mark.
   */
  played(seq: number): void {
    if (this.isStopped) return;
    if (!Number.isFinite(seq) || seq <= this.lastPlayedSeq) return;
    this.lastPlayedSeq = seq;
    if (this.drainTimer === null || !this.hasDrained()) return;
    this.clearDrainTimer();
    this.finishIfDrained();
  }

  /** Terminal and idempotent: cancels the turn, aborts playback, ignores everything after. */
  stop(reason: VoiceStopReason): void {
    if (this.isStopped) return;
    this.isStopped = true;

    const turn = this.turn;
    this.turn = null;
    this.queue = [];
    this.queuedTranscripts = [];
    this.pendingQuestion = null;
    this.utteranceGeneration++;
    this.abortSynthesis();
    this.clearDrainTimer();
    this.innerState = 'stopped';
    this.speakingSince = null;

    if (turn && !turn.done) this.cancelTurn(turn.id);
    this.emit({ type: 'voice_stopped', reason });
  }

  // --- capture -------------------------------------------------------------

  private onSpeechStart(): void {
    // Advisory only: the guard is what makes a barge-in real. Speech that
    // starts before the user could have heard the reply is the TTS itself
    // leaking into the mic, or the user finishing their own sentence.
    if (this.innerState !== 'speaking' || this.speakingSince === null) return;
    if (this.now() - this.speakingSince < BARGE_IN_GUARD_MS) return;
    this.bargeIn();
  }

  /**
   * Queues an utterance for transcription behind whatever is already in flight.
   * The chain's `catch` is the session's last line of defence: a throw from a
   * caller-supplied callback (`emit`, `driver.start`) would otherwise reject a
   * floating promise and, with no `unhandledRejection` handler in the host,
   * take the process down.
   */
  private enqueueUtterance(pcm: Uint8Array): void {
    const generation = this.utteranceGeneration;
    this.transcribeChain = this.transcribeChain
      .then(() => this.onUtterance(pcm, generation))
      .catch((error) => this.fail(error));
  }

  private async onUtterance(pcm: Uint8Array, generation: number): Promise<void> {
    if (this.stopped(generation)) return;
    // `listening` is the only state an utterance can interrupt: during a turn
    // it is queued (state unchanged), and while a question is pending the turn
    // is non-null but the session IS listening, so the answer transcribes too.
    if (this.innerState === 'listening') this.setState('transcribing');

    let text: string;
    try {
      const config = await this.speech.currentConfig();
      const audio = wavFromPcm16(pcm, CAPTURE_SAMPLE_RATE);
      const result = await this.speech.transcribe(audio, 'wav', config.stt.language);
      text = result.text.trim();
    } catch (error) {
      if (this.stopped(generation)) return;
      this.emitError(error);
      if (this.innerState === 'transcribing') this.setState('listening');
      return;
    }

    if (this.stopped(generation)) return;
    if (!text) {
      // Nothing was said (or nothing survived the trim): no turn, no frame.
      if (this.innerState === 'transcribing') this.setState('listening');
      return;
    }

    if (this.pendingQuestion) {
      const pending = this.pendingQuestion;
      this.emit({ type: 'voice_transcript', text, final: true });
      this.answerQuestion(pending, text);
      return;
    }

    if (this.turn) {
      // Spoken over a running turn and not a barge-in: queue it. B9 keys the
      // optimistic row on the SECOND emission of this transcript, the one that
      // carries the turnId once the turn actually starts.
      this.emit({ type: 'voice_transcript', text, final: true });
      this.queuedTranscripts.push(text);
      if (this.innerState === 'transcribing') this.setState('thinking', this.turn.id);
      return;
    }

    this.startTurn(text);
  }

  /**
   * Sends `text` as the answer to `pending`. The transcript frame is emitted by
   * the caller, since a queued transcript already announced itself when it was
   * captured and must not be announced twice.
   */
  private answerQuestion(pending: { turnId: string; questionId: string }, text: string): void {
    this.pendingQuestion = null;
    this.setState('thinking', pending.turnId);
    void Promise.resolve()
      .then(() => this.driver.answer(pending.turnId, pending.questionId, text))
      .catch((error) => this.answerFailed(pending.turnId, error));
  }

  /**
   * The driver could not deliver the answer. The turn is unreachable now — left
   * alive it would swallow every later utterance into the queue — so it is
   * cancelled and retired.
   */
  private answerFailed(turnId: string, error: unknown): void {
    if (this.isStopped) return;
    this.emitError(error);
    if (this.turn?.id === turnId) {
      this.cancelTurn(turnId);
      this.turn = null;
    }
    // F9: the dead turn's in-flight sentence has to be aborted BEFORE the
    // queue is cleared, exactly as `bargeIn()` does. Left streaming, its next
    // chunk would reach `emitSpeech` and announce whatever turn
    // `advanceAfterTurn` had since started as already speaking.
    this.abortSynthesis();
    this.clearDrainTimer();
    this.queue = [];
    this.advanceAfterTurn();
  }

  private startTurn(text: string): void {
    const turnId = this.newTurnId();
    const turn: Turn = { id: turnId, renderer: this.newRenderer(), done: false, spoke: false };
    this.turn = turn;

    // Before driver.start, always: the phone dispatches its optimistic user
    // row from this frame and would otherwise render the turn as remote.
    this.emit({ type: 'voice_transcript', text, final: true, turnId });
    this.driver.start(
      turnId,
      text,
      (event) => this.onAgentEvent(turn, event),
      (outcome, error, code) => this.onTurnDone(turn, outcome, error, code),
    );
    this.setState('thinking', turnId);
  }

  // --- turn ----------------------------------------------------------------

  private onAgentEvent(turn: Turn, event: AgentEvent): void {
    if (this.isStopped || this.turn !== turn) return;
    this.enqueue(turn, turn.renderer.event(event));
  }

  private onTurnDone(
    turn: Turn,
    outcome: 'completed' | 'cancelled' | 'failed',
    error?: string,
    code?: MobileApiErrorCode,
  ): void {
    if (this.isStopped || this.turn !== turn) return;
    turn.done = true;
    // F4: `conversation_busy` / `not_found` / `unauthorized` describe the
    // CONVERSATION, not this turn — every later utterance would earn the same
    // error and the cover would sit there with no way out but Close. End the
    // session instead, with the hub's own code rather than a flat `provider`.
    // `done` is set above first, so `stop()` owes no `driver.cancel` for a
    // turn the hub never started.
    if (outcome === 'failed' && code !== undefined && FATAL_HUB_CODES[code] !== undefined) {
      this.emit({
        type: 'voice_error',
        code: FATAL_HUB_CODES[code] as SpeechErrorCode,
        error: error ?? 'turn failed',
      });
      this.stop('provider');
      return;
    }
    // Reported once the speech already rendered for this turn has drained, so
    // the failure lands after the half-answer the user is still hearing.
    if (outcome === 'failed') turn.failure = error ?? 'turn failed';
    // A question this turn asked can no longer be answered — leaving it pending
    // would park `finishIfDrained` on a finished turn forever.
    if (this.pendingQuestion?.turnId === turn.id) this.pendingQuestion = null;
    this.enqueue(turn, turn.renderer.end());
    this.pump();
  }

  private bargeIn(): void {
    this.abortSynthesis();
    this.clearDrainTimer();
    this.queue = [];
    this.queuedTranscripts = [];
    this.pendingQuestion = null;
    // Anything still being transcribed belongs to the conversation the user
    // just interrupted; the interrupting utterance is the new generation.
    this.utteranceGeneration++;

    const turn = this.turn;
    this.turn = null;
    if (turn && !turn.done) this.cancelTurn(turn.id);

    // The utterance that interrupted is still being captured by the VAD; its
    // `speech_end` starts the next turn like any other.
    this.setState('listening');
  }

  // --- synthesis -----------------------------------------------------------

  private enqueue(turn: Turn, items: SpeechItem[]): void {
    for (const item of items) {
      if (!item.text.trim()) continue;
      this.queue.push({ turn, item });
    }
    this.pump();
  }

  private pump(): void {
    if (this.isStopped || this.synthesizing) return;
    const next = this.queue.shift();
    if (!next) {
      this.finishIfDrained();
      return;
    }
    this.synthesizing = true;
    void this.speak(next.turn, next.item).catch((error) => this.fail(error));
  }

  private async speak(turn: Turn, item: SpeechItem): Promise<void> {
    const generation = this.generation;

    let result: Awaited<ReturnType<SpeechService['synthesize']>>;
    try {
      result = await this.speech.synthesize(item.text);
    } catch (error) {
      if (this.stale(generation)) return;
      this.synthesizing = false;
      this.synthesisFailed(error);
      return;
    }

    const iterator = result.audio[Symbol.asyncIterator]();
    if (this.stale(generation)) {
      void iterator.return?.().catch(() => undefined);
      return;
    }
    this.activeIterator = iterator;

    const collected: Uint8Array[] = [];
    let firstChunk = true;
    try {
      for (;;) {
        const next = await iterator.next();
        if (this.stale(generation)) return;
        if (next.done) break;
        if (result.format === 'pcm16') {
          // F2: `text` is the caption for the SENTENCE, and a PCM sentence is
          // several chunks. Repeating it on every chunk made the client's
          // `assistantCaption += text` read "One.One.One." — so only the
          // first chunk of a sentence carries it.
          this.emitSpeech(
            next.value,
            firstChunk ? item.text : '',
            result.format,
            result.sampleRate,
          );
          firstChunk = false;
        } else {
          collected.push(next.value);
        }
      }
    } catch (error) {
      if (this.stale(generation)) return;
      this.activeIterator = null;
      this.synthesizing = false;
      this.synthesisFailed(error);
      return;
    }

    this.activeIterator = null;
    if (result.format !== 'pcm16' && collected.length > 0) {
      // MP3 is a single frame per sentence: the phone's decoder wants whole
      // frames, and a sentence is short enough to hold.
      this.emitSpeech(concatChunks(collected), item.text, result.format, result.sampleRate);
    }
    if (item.kind === 'question') {
      // Only once it has been SPOKEN is the next utterance an answer.
      this.pendingQuestion = { turnId: turn.id, questionId: item.questionId };
    }

    this.consecutiveSynthesisFailures = 0;
    this.synthesizing = false;
    this.pump();
  }

  /**
   * One sentence could not be synthesized (F3).
   *
   * A retryable code (`unavailable`/`network` — what `SpeechService` maps a
   * provider 429/5xx to) costs that sentence and nothing else: the error is
   * reported, the sentence is dropped and the queue keeps moving, exactly as
   * a failed TRANSCRIPTION does. Anything else, or three retryable failures
   * in a row, is a provider outage and ends the session.
   */
  private synthesisFailed(error: unknown): void {
    if (this.isStopped) return;
    this.consecutiveSynthesisFailures++;
    const code = error instanceof SpeechError ? error.code : 'provider';
    const retryable = code === 'unavailable' || code === 'network';
    if (!retryable || this.consecutiveSynthesisFailures >= MAX_CONSECUTIVE_SYNTHESIS_FAILURES) {
      this.fail(error);
      return;
    }
    this.emitError(error);
    this.pump();
  }

  /** True once this synthesis has been aborted (barge-in or stop) or the session stopped. */
  private stale(generation: number): boolean {
    return this.isStopped || this.generation !== generation;
  }

  /** True once this utterance's conversation is gone (barge-in) or the session stopped. */
  private stopped(generation: number): boolean {
    return this.isStopped || this.utteranceGeneration !== generation;
  }

  private abortSynthesis(): void {
    this.generation++;
    this.synthesizing = false;
    const iterator = this.activeIterator;
    this.activeIterator = null;
    if (iterator?.return) void iterator.return().catch(() => undefined);
  }

  private finishIfDrained(): void {
    if (this.isStopped || this.synthesizing || this.queue.length > 0) return;

    if (this.pendingQuestion) {
      // F1, as below: the question's audio is still playing, and the client
      // flushes playback the moment the session leaves `speaking`.
      if (!this.awaitDrain()) return;
      const pending = this.pendingQuestion;
      // Anything the user said while the question was being spoken IS the
      // answer — dropping it would lose speech the session already echoed back.
      const answer = this.queuedTranscripts.shift();
      if (answer !== undefined) {
        this.answerQuestion(pending, answer);
        return;
      }
      // The turn is paused on a question, not finished: listen for the answer.
      if (this.innerState !== 'listening') this.setState('listening');
      return;
    }

    const turn = this.turn;
    // Deliberately BEFORE the drain gate. `pump()` reaches here every time the
    // queue empties, which is after EVERY sentence — arming the safety timer
    // there would count its slack down from the wrong end of the turn, and
    // once it fired it would raise the played high-water mark, so the turn's
    // real end would pass the gate with no acknowledgement at all.
    if (!turn || !turn.done) return;
    // F1: everything below leaves `speaking`, and the client flushes playback
    // when it does — so nothing below may run until the phone says it has
    // finished playing what is already on the wire.
    if (!this.awaitDrain()) return;
    this.turn = null;
    if (turn.failure !== undefined) {
      this.emit({ type: 'voice_error', code: 'provider', error: turn.failure });
    }
    this.advanceAfterTurn();
  }

  /**
   * True when it is safe to leave `speaking`: either this turn spoke nothing,
   * or the phone has acknowledged the last chunk. Otherwise arms the safety
   * timer (once) and returns false; `played()` or the timer re-enters
   * `finishIfDrained`.
   */
  private awaitDrain(): boolean {
    const spoke = this.turn?.spoke ?? false;
    if (!spoke || this.hasDrained()) {
      this.clearDrainTimer();
      return true;
    }
    if (this.drainTimer !== null) return false;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      // The client never acknowledged. Leaving the session in `speaking`
      // forever is worse than a tail the user may hear clipped, so treat
      // everything on the wire as played and advance. Raising the high-water
      // mark (rather than just re-entering) is what stops the re-entrant
      // `finishIfDrained` below from arming a second timer for the same turn.
      this.lastPlayedSeq = this.lastEmittedSeq;
      this.finishIfDrained();
    }, this.drainTimeoutMs);
    // A pending drain must never hold the process open.
    this.drainTimer.unref?.();
    return false;
  }

  private hasDrained(): boolean {
    return this.lastPlayedSeq >= this.lastEmittedSeq;
  }

  private clearDrainTimer(): void {
    if (this.drainTimer === null) return;
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  /** Starts the oldest queued transcript, or settles back into `listening`. */
  private advanceAfterTurn(): void {
    const queued = this.queuedTranscripts.shift();
    if (queued !== undefined) {
      this.startTurn(queued);
      return;
    }
    if (this.innerState !== 'listening') this.setState('listening');
  }

  /**
   * Terminal failure of the session, from anywhere including a rejected
   * floating promise. Best-effort by construction: if the caller's `emit`
   * is what threw, there is nowhere left to report it.
   */
  private fail(error: unknown): void {
    if (this.isStopped) return;
    try {
      this.emitError(error);
    } catch {
      // The frame sink itself failed; the stop below is still worth attempting.
    }
    try {
      this.stop('provider');
    } catch {
      // Nothing left to do — the session is unusable either way.
    }
  }

  /** `driver.cancel` is fire-and-forget, and may throw synchronously. */
  private cancelTurn(turnId: string): void {
    void Promise.resolve()
      .then(() => this.driver.cancel(turnId))
      .catch(() => undefined);
  }

  // --- frames --------------------------------------------------------------

  private emitSpeech(
    chunk: Uint8Array,
    text: string,
    format: 'pcm16' | 'mp3',
    sampleRate: number | undefined,
  ): void {
    if (this.innerState !== 'speaking') this.setState('speaking', this.turn?.id);
    if (this.turn) this.turn.spoke = true;
    this.lastEmittedSeq = this.seq;
    this.emit({
      type: 'voice_speech',
      seq: this.seq++,
      audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'),
      format,
      ...(sampleRate === undefined ? {} : { sampleRate }),
      text,
    });
  }

  private setState(state: VoiceState, turnId?: string): void {
    const previous = this.innerState;
    this.innerState = state;

    if (state === 'speaking') {
      this.speakingSince = this.now();
      this.vad.setStartMs(SPEAKING_START_MS);
    } else if (previous === 'speaking') {
      this.speakingSince = null;
      this.vad.setStartMs(LISTENING_START_MS);
    }

    this.emitState(state, turnId);
  }

  /** Emits a `voice_state` unless muted — while muted the client shows "muted". */
  private emitState(state: VoiceState, turnId?: string): void {
    if (this.muted) return;
    const id = turnId ?? (state === 'thinking' || state === 'speaking' ? this.turn?.id : undefined);
    this.emit({ type: 'voice_state', state, ...(id === undefined ? {} : { turnId: id }) });
  }

  private emitError(error: unknown): void {
    const code: SpeechErrorCode = error instanceof SpeechError ? error.code : 'provider';
    const message = error instanceof Error ? error.message : 'speech provider failed';
    this.emit({ type: 'voice_error', code, error: message });
  }

  private emit(frame: WithoutId<VoiceServerFrame>): void {
    this.emitFrame({ ...frame, id: this.id } as VoiceServerFrame);
  }
}
