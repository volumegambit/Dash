import type { AgentEvent } from '@dash/agent';
import type { MobileApiErrorCode } from '@dash/mobile-contract';
import { DEFAULT_SPEECH_CONFIG, type SpeechConfig } from './config.js';
import type { SpeechProviderStatus, SpeechService } from './service.js';
import type { TurnDriver } from './session.js';
import type { AudioFormat, SpeechModel, SpeechModelKind, Transcription } from './types.js';

/**
 * Test doubles for {@link VoiceSession}. Deliberately NOT exported from
 * `index.ts` — they are test infrastructure, not part of the package's
 * public surface, and they only live in `src/` (rather than beside a single
 * `.test.ts`) so the gateway's own session tests can reuse them.
 *
 * Both doubles are DEFERRED: nothing resolves on its own. A test resolves a
 * transcription, pushes synthesis chunks, delivers agent events and completes
 * a turn explicitly, which is the only way to assert orderings such as
 * "an utterance that ends while the turn is still running is queued".
 */

/** One in-flight `transcribe()` call, resolved by the test. */
export interface PendingTranscription {
  audio: Uint8Array;
  format: AudioFormat;
  language?: string;
  resolve(text: string, durationSeconds?: number): void;
  reject(error: unknown): void;
}

/**
 * A synthesis stream the test drives: `push()` a chunk, `end()` it, or
 * `fail()` it mid-stream. `returned` records whether the consumer called the
 * iterator's `return()` — i.e. whether it aborted, as barge-in and `stop` do.
 */
export class FakeSynthesis {
  returned = false;

  private readonly chunks: Uint8Array[] = [];
  private finished = false;
  private failure: unknown;
  private waiters: (() => void)[] = [];

  constructor(
    readonly text: string,
    readonly format: 'pcm16' | 'mp3',
    readonly sampleRate?: number,
  ) {}

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.wake();
  }

  end(): void {
    this.finished = true;
    this.wake();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.finished = true;
    this.wake();
  }

  get audio(): AsyncIterable<Uint8Array> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            for (;;) {
              const chunk = self.chunks.shift();
              if (chunk) return { done: false, value: chunk };
              if (self.failure !== undefined) {
                const error = self.failure;
                self.failure = undefined;
                throw error;
              }
              if (self.finished || self.returned) return { done: true, value: undefined };
              await new Promise<void>((resolve) => self.waiters.push(resolve));
            }
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            self.returned = true;
            self.wake();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export interface FakeSpeechServiceOptions {
  config?: SpeechConfig;
  /** Format reported by every `synthesize()` result. Defaults to 'mp3' (the default model). */
  format?: 'pcm16' | 'mp3';
  sampleRate?: number;
}

/** A {@link SpeechService} whose transcriptions and syntheses the test drives. */
export class FakeSpeechService implements SpeechService {
  readonly transcribes: PendingTranscription[] = [];
  readonly syntheses: FakeSynthesis[] = [];
  /** When set, the next `synthesize()` call rejects with it. */
  failSynthesizeWith: unknown;

  private readonly config: SpeechConfig;
  private readonly format: 'pcm16' | 'mp3';
  private readonly sampleRate?: number;

  constructor(options: FakeSpeechServiceOptions = {}) {
    this.config = options.config ?? DEFAULT_SPEECH_CONFIG;
    this.format = options.format ?? 'mp3';
    this.sampleRate = options.sampleRate;
  }

  async currentConfig(): Promise<SpeechConfig> {
    return this.config;
  }

  async providers(): Promise<SpeechProviderStatus[]> {
    return [];
  }

  async listModels(_kind: SpeechModelKind): Promise<SpeechModel[]> {
    return [];
  }

  transcribe(audio: Uint8Array, format: AudioFormat, language?: string): Promise<Transcription> {
    return new Promise<Transcription>((resolve, reject) => {
      this.transcribes.push({
        audio,
        format,
        language,
        resolve: (text, durationSeconds) => resolve({ text, durationSeconds }),
        reject,
      });
    });
  }

  async synthesize(
    text: string,
    _format?: 'pcm16' | 'mp3',
  ): Promise<{ format: 'pcm16' | 'mp3'; sampleRate?: number; audio: AsyncIterable<Uint8Array> }> {
    if (this.failSynthesizeWith !== undefined) {
      throw this.failSynthesizeWith;
    }
    const synthesis = new FakeSynthesis(text, this.format, this.sampleRate);
    this.syntheses.push(synthesis);
    return { format: synthesis.format, sampleRate: synthesis.sampleRate, audio: synthesis.audio };
  }

  async available(): Promise<boolean> {
    return true;
  }

  invalidate(): void {}
}

interface TurnHandlers {
  onEvent(event: AgentEvent): void;
  onDone(
    outcome: 'completed' | 'cancelled' | 'failed',
    error?: string,
    code?: MobileApiErrorCode,
  ): void;
}

/** A {@link TurnDriver} that records calls and lets the test drive each turn. */
export class FakeTurnDriver implements TurnDriver {
  readonly starts: { turnId: string; text: string }[] = [];
  readonly answers: { turnId: string; questionId: string; answer: string }[] = [];
  readonly cancels: string[] = [];
  /** When set, `start` throws it synchronously (a dead hub, a bug in the caller). */
  failStartWith: unknown;
  /** When set, `answer` throws it synchronously. */
  failAnswerWith: unknown;
  /** When set, `cancel` throws it synchronously — the nastiest case, since callers ignore it. */
  failCancelWith: unknown;

  private readonly handlers = new Map<string, TurnHandlers>();

  /** Called for every driver method, so a test can interleave calls and frames on one timeline. */
  constructor(private readonly onCall?: (call: 'start' | 'answer' | 'cancel') => void) {}

  start(
    turnId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
    onDone: (
      outcome: 'completed' | 'cancelled' | 'failed',
      error?: string,
      code?: MobileApiErrorCode,
    ) => void,
  ): void {
    this.starts.push({ turnId, text });
    this.handlers.set(turnId, { onEvent, onDone });
    this.onCall?.('start');
    if (this.failStartWith !== undefined) throw this.failStartWith;
  }

  // Deliberately not `async`: these throw SYNCHRONOUSLY so a caller that
  // forgets to wrap the call cannot hide behind a rejected promise.
  answer(turnId: string, questionId: string, answer: string): Promise<void> {
    this.answers.push({ turnId, questionId, answer });
    this.onCall?.('answer');
    if (this.failAnswerWith !== undefined) throw this.failAnswerWith;
    return Promise.resolve();
  }

  cancel(turnId: string): Promise<void> {
    this.cancels.push(turnId);
    this.onCall?.('cancel');
    if (this.failCancelWith !== undefined) throw this.failCancelWith;
    return Promise.resolve();
  }

  /** Delivers an agent event to the session that started `turnId`. */
  event(turnId: string, event: AgentEvent): void {
    this.handlersFor(turnId).onEvent(event);
  }

  /** Completes `turnId`. `code` is the hub's own error code for a `failed` outcome. */
  done(
    turnId: string,
    outcome: 'completed' | 'cancelled' | 'failed' = 'completed',
    error?: string,
    code?: MobileApiErrorCode,
  ): void {
    this.handlersFor(turnId).onDone(outcome, error, code);
  }

  private handlersFor(turnId: string): TurnHandlers {
    const handlers = this.handlers.get(turnId);
    if (!handlers) throw new Error(`FakeTurnDriver: unknown turn ${turnId}`);
    return handlers;
  }
}
