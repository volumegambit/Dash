const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_START_MS = 300;
const DEFAULT_END_MS = 700;
const DEFAULT_MIN_UTTERANCE_MS = 500;
const DEFAULT_MAX_UTTERANCE_MS = 60000;
const DEFAULT_THRESHOLD = 3.0;

/** Fixed pre-roll window kept while not speaking, independent of `startMs`. */
const PRE_ROLL_MS = 300;
const NOISE_FLOOR_INIT = 1e-4;
const NOISE_FLOOR_MIN = 1e-4;
const NOISE_FLOOR_ALPHA = 0.05;

export interface VadOptions {
  /** PCM16 sample rate in Hz. Default 16000. */
  sampleRate?: number;
  /** Consecutive above-threshold audio required to confirm speech, in ms. Default 300. */
  startMs?: number;
  /** Consecutive below-threshold audio required to confirm silence, in ms. Default 700. */
  endMs?: number;
  /** Utterances shorter than this are dropped silently (no `speech_end`). Default 500. */
  minUtteranceMs?: number;
  /** Hard cap on one utterance; beyond it a `reason: 'max'` `speech_end` fires and
   * capture continues as a new utterance. Default 60000. */
  maxUtteranceMs?: number;
  /** RMS multiple over the adaptive noise floor that counts as speech. Default 3.0. */
  threshold?: number;
}

export type VadEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end'; pcm: Uint8Array; durationMs: number; reason: 'silence' | 'max' }
  | { type: 'level'; rms: number };

function concatChunks(chunks: Uint8Array[]): Uint8Array {
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

/** RMS of a little-endian PCM16 frame, normalised to 0..1 (int16 / 32768). */
function rmsOf(frame: Uint8Array): number {
  const sampleCount = Math.floor(frame.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Energy-based voice activity detector for headerless, little-endian, mono
 * PCM16 audio. `push()` frames may be any length — the client typically
 * sends ~20-100ms chunks — and all durations are accumulated from byte
 * counts, never frame counts, so callers don't need to align to any grid.
 *
 * Speech is confirmed once RMS stays above `threshold * noiseFloor` for
 * `startMs`; the noise floor is an exponential moving average (alpha 0.05)
 * of RMS over frames classified as non-speech, floored at 1e-4. A rolling
 * pre-roll of up to 300ms of audio observed while not speaking is kept and
 * prepended to the utterance, so the confirmation delay doesn't clip the
 * onset. Speech ends once RMS stays at or below threshold for `endMs`; the
 * trailing silence used only to confirm the end is not included in the
 * emitted `pcm`. An utterance exceeding `maxUtteranceMs` is cut at exactly
 * that many bytes and capture continues immediately as a new utterance.
 */
export class VoiceActivityDetector {
  private readonly bytesPerMs: number;
  private readonly endMs: number;
  private readonly minUtteranceMs: number;
  private readonly maxUtteranceMs: number;
  private readonly threshold: number;
  private startMs: number;

  private floor = NOISE_FLOOR_INIT;
  private _speaking = false;

  // Idle / candidate state (not speaking).
  private ring: Uint8Array[] = [];
  private ringBytes = 0;
  private candidate: Uint8Array[] = [];
  private candidateSnapshot: Uint8Array | null = null;
  private aboveMs = 0;

  // Speaking state.
  private utterance: Uint8Array[] = [];
  private utteranceBytes = 0;
  private trailing: Uint8Array[] = [];
  private belowMs = 0;

  constructor(opts: VadOptions = {}) {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.bytesPerMs = (sampleRate / 1000) * 2;
    this.startMs = opts.startMs ?? DEFAULT_START_MS;
    this.endMs = opts.endMs ?? DEFAULT_END_MS;
    this.minUtteranceMs = opts.minUtteranceMs ?? DEFAULT_MIN_UTTERANCE_MS;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS;
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  /** Overrides the startMs confirmation window from here on (options otherwise persist). */
  setStartMs(ms: number): void {
    this.startMs = ms;
  }

  /** Clears all detection state (floor, buffers, speaking) but leaves configured options. */
  reset(): void {
    this.floor = NOISE_FLOOR_INIT;
    this._speaking = false;
    this.ring = [];
    this.ringBytes = 0;
    this.candidate = [];
    this.candidateSnapshot = null;
    this.aboveMs = 0;
    this.utterance = [];
    this.utteranceBytes = 0;
    this.trailing = [];
    this.belowMs = 0;
  }

  push(frame: Uint8Array): VadEvent[] {
    const events: VadEvent[] = [];
    if (frame.length === 0) return events;

    const rms = rmsOf(frame);
    events.push({ type: 'level', rms });

    if (this._speaking) {
      this.pushWhileSpeaking(frame, rms, events);
    } else {
      this.pushWhileIdle(frame, rms, events);
    }
    return events;
  }

  private pushWhileIdle(frame: Uint8Array, rms: number, events: VadEvent[]): void {
    const frameMs = frame.length / this.bytesPerMs;
    const above = rms > this.threshold * this.floor;

    if (above) {
      if (this.aboveMs === 0) {
        this.candidateSnapshot = concatChunks(this.ring);
      }
      this.candidate.push(frame);
      this.aboveMs += frameMs;
      this.pushToRing(frame);

      if (this.aboveMs >= this.startMs) {
        const pending = [this.candidateSnapshot ?? new Uint8Array(0), ...this.candidate];
        this.candidate = [];
        this.candidateSnapshot = null;
        this.aboveMs = 0;
        this._speaking = true;
        events.push({ type: 'speech_start' });
        for (const chunk of pending) this.appendToUtterance(chunk, events);
      }
      return;
    }

    // Below threshold: adapt the noise floor and drop any failed candidate run.
    this.floor = Math.max(
      NOISE_FLOOR_MIN,
      (1 - NOISE_FLOOR_ALPHA) * this.floor + NOISE_FLOOR_ALPHA * rms,
    );
    this.pushToRing(frame);
    if (this.aboveMs > 0) {
      this.candidate = [];
      this.candidateSnapshot = null;
      this.aboveMs = 0;
    }
  }

  private pushWhileSpeaking(frame: Uint8Array, rms: number, events: VadEvent[]): void {
    const frameMs = frame.length / this.bytesPerMs;
    const above = rms > this.threshold * this.floor;

    if (above) {
      if (this.trailing.length > 0) {
        const flushed = concatChunks(this.trailing);
        this.trailing = [];
        this.appendToUtterance(flushed, events);
      }
      this.belowMs = 0;
      this.appendToUtterance(frame, events);
      return;
    }

    this.trailing.push(frame);
    this.belowMs += frameMs;

    if (this.belowMs >= this.endMs) {
      this.finalizeUtterance('silence', events);
      // The trailing silence that confirmed the end seeds the next pre-roll.
      this.ring = [];
      this.ringBytes = 0;
      this.pushToRing(concatChunks(this.trailing));
      this.trailing = [];
      this.belowMs = 0;
    }
  }

  /** Appends bytes to the current utterance, splitting and cutting at maxUtteranceMs. */
  private appendToUtterance(bytes: Uint8Array, events: VadEvent[]): void {
    if (bytes.length === 0) return;
    const maxBytes = this.maxUtteranceMs * this.bytesPerMs;
    const allowed = maxBytes - this.utteranceBytes;

    if (bytes.length <= allowed) {
      this.utterance.push(bytes);
      this.utteranceBytes += bytes.length;
      if (this.utteranceBytes >= maxBytes) {
        this.finalizeUtterance('max', events);
        this._speaking = true;
        events.push({ type: 'speech_start' });
      }
      return;
    }

    const head = bytes.subarray(0, allowed);
    const tail = bytes.subarray(allowed);
    if (head.length > 0) {
      this.utterance.push(head);
      this.utteranceBytes += head.length;
    }
    this.finalizeUtterance('max', events);
    this._speaking = true;
    events.push({ type: 'speech_start' });
    if (tail.length > 0) this.appendToUtterance(tail, events);
  }

  private finalizeUtterance(reason: 'silence' | 'max', events: VadEvent[]): void {
    const pcm = concatChunks(this.utterance);
    const durationMs = pcm.length / this.bytesPerMs;
    this.utterance = [];
    this.utteranceBytes = 0;
    this._speaking = false;

    if (reason === 'max' || durationMs >= this.minUtteranceMs) {
      events.push({ type: 'speech_end', pcm, durationMs, reason });
    }
    // Otherwise the utterance is shorter than minUtteranceMs: dropped silently.
  }

  private pushToRing(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.ring.push(chunk);
    this.ringBytes += chunk.length;
    const cap = PRE_ROLL_MS * this.bytesPerMs;
    while (this.ringBytes > cap && this.ring.length > 0) {
      const head = this.ring[0];
      const excess = this.ringBytes - cap;
      if (excess >= head.length) {
        this.ring.shift();
        this.ringBytes -= head.length;
      } else {
        this.ring[0] = head.subarray(excess);
        this.ringBytes -= excess;
      }
    }
  }
}
