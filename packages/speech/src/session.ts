import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@dash/agent';
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
    onDone: (outcome: 'completed' | 'cancelled' | 'failed', error?: string) => void,
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
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

interface Turn {
  id: string;
  renderer: SpokenRenderer;
  /** The driver has called `onDone` — no `cancel` is owed and the queue may drain to `listening`. */
  done: boolean;
  /** Set when the turn ended `failed`; reported once its speech has drained. */
  failure?: string;
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

  constructor(options: VoiceSessionOptions) {
    this.id = options.id;
    this.speech = options.speech;
    this.driver = options.driver;
    this.emitFrame = options.emit;
    this.vad = options.vad ?? new VoiceActivityDetector();
    this.now = options.now ?? Date.now;
    this.newTurnId = options.newTurnId ?? (() => randomUUID());
    this.newRenderer = options.renderer ?? (() => new SpokenRenderer({ now: this.now }));

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
    this.queue = [];
    this.advanceAfterTurn();
  }

  private startTurn(text: string): void {
    const turnId = this.newTurnId();
    const turn: Turn = { id: turnId, renderer: this.newRenderer(), done: false };
    this.turn = turn;

    // Before driver.start, always: the phone dispatches its optimistic user
    // row from this frame and would otherwise render the turn as remote.
    this.emit({ type: 'voice_transcript', text, final: true, turnId });
    this.driver.start(
      turnId,
      text,
      (event) => this.onAgentEvent(turn, event),
      (outcome, error) => this.onTurnDone(turn, outcome, error),
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
  ): void {
    if (this.isStopped || this.turn !== turn) return;
    turn.done = true;
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
      this.fail(error);
      return;
    }

    const iterator = result.audio[Symbol.asyncIterator]();
    if (this.stale(generation)) {
      void iterator.return?.().catch(() => undefined);
      return;
    }
    this.activeIterator = iterator;

    const collected: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await iterator.next();
        if (this.stale(generation)) return;
        if (next.done) break;
        if (result.format === 'pcm16') {
          this.emitSpeech(next.value, item.text, result.format, result.sampleRate);
        } else {
          collected.push(next.value);
        }
      }
    } catch (error) {
      if (this.stale(generation)) return;
      this.activeIterator = null;
      this.synthesizing = false;
      this.fail(error);
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

    this.synthesizing = false;
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
    if (!turn || !turn.done) return;
    this.turn = null;
    if (turn.failure !== undefined) {
      this.emit({ type: 'voice_error', code: 'provider', error: turn.failure });
    }
    this.advanceAfterTurn();
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
