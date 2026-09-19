const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_START_MS = 300;
const DEFAULT_END_MS = 700;
const DEFAULT_MIN_UTTERANCE_MS = 500;
const DEFAULT_MAX_UTTERANCE_MS = 60000;
const DEFAULT_THRESHOLD = 3.0;
const DEFAULT_CALIBRATION_MS = 500;

/** Fixed pre-roll window kept while not speaking, independent of `startMs`. */
const PRE_ROLL_MS = 300;
const NOISE_FLOOR_INIT = 1e-4;
const NOISE_FLOOR_MIN = 1e-4;
/** EMA alpha at a 20ms frame; see `floorAlphaFor` for the time-based scaling. */
const NOISE_FLOOR_ALPHA_PER_20MS = 0.05;

/**
 * Per-frame EMA alpha scaled so the *time constant* is identical regardless
 * of how the caller chunks its frames — a fixed alpha applied once per call
 * would make the floor adapt slower with larger frames (fewer calls per
 * second of audio) and faster with smaller ones, for the same elapsed time.
 */
function floorAlphaFor(frameMs: number): number {
  return 1 - (1 - NOISE_FLOOR_ALPHA_PER_20MS) ** (frameMs / 20);
}

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
  /** Leading window (ms) that only seeds the noise floor — no detection, no pre-roll.
   * Runs once after construction and again after every `reset()`. 0 disables it
   * (immediate cold-start detection, the pre-calibration behaviour). Default 500. */
  calibrationMs?: number;
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
 * A zero-length frame returns `[]` (not even a `level` event). An odd-length
 * frame contributes `floor(n/2)` samples to that frame's `level.rms`, and
 * its trailing unpaired byte is dropped before storage — a stray byte kept
 * mid-stream would shift the alignment of every sample concatenated after
 * it in the eventual utterance `pcm`. A 1-byte frame trims to zero: its
 * `level` is still emitted (the original frame wasn't zero-length), but it
 * is otherwise ignored — in particular it does not cancel an in-progress
 * candidate run the way a genuine below-threshold frame would.
 *
 * Speech is confirmed once RMS stays above `threshold * noiseFloor` for
 * `startMs`; the noise floor is an exponential moving average of RMS over
 * frames classified as non-speech, floored at 1e-4. The alpha is time-based
 * (scaled from a 0.05-per-20ms base by `frameMs / 20`), not a flat
 * per-`push()` constant, so the floor's time constant — how many
 * milliseconds of audio it takes to adapt — is identical whether the
 * caller sends 20ms or 100ms frames; a flat per-call alpha would make the
 * floor adapt faster for callers who happen to chunk smaller. A rolling
 * pre-roll of up to 300ms of audio observed while not speaking is kept and
 * prepended to the utterance, so the confirmation delay doesn't clip the
 * onset. Speech ends once RMS stays at or below threshold for `endMs`; the
 * trailing silence used only to confirm the end is not included in the
 * emitted `pcm`. An utterance exceeding `maxUtteranceMs` is cut at exactly
 * that many bytes and capture continues immediately as a new utterance.
 *
 * The first `calibrationMs` of audio (after construction, and again after
 * every `reset()`) is a calibration window: frames only update the running
 * mean RMS and emit `level` events — no detection runs and no pre-roll is
 * collected — and once the window elapses the floor is seeded from that
 * mean (still floored at 1e-4) before the normal EMA takes over. A frame
 * that straddles the end of the window is absorbed whole into calibration
 * (calibration is never split mid-frame); the window simply ends on
 * whichever frame's cumulative duration first reaches `calibrationMs`, so
 * the true calibration window is `calibrationMs` rounded up to the nearest
 * frame boundary the caller happens to use. This avoids classifying a real
 * microphone's resting noise as speech from the first frame, which the
 * plain cold 1e-4 floor would do on most hardware.
 *
 * Self-healing complements this: whenever an utterance ends with
 * `reason: 'max'` — a strong signal that the floor is currently too low for
 * the environment (something has read as continuous "speech" for a full
 * minute) — a re-seed from that utterance's own RMS is staged rather than
 * applied immediately. This deferral is a deliberate invariant, not a
 * workaround: applying it immediately would judge the very next frames —
 * almost always this same utterance's own continuation — against a floor
 * just raised to match their own energy, so a genuine multi-minute
 * monologue would grow progressively deaf to itself, chopping into shorter
 * and shorter false utterances every time it crossed `maxUtteranceMs`. The
 * stage is applied at whichever comes first: the next genuine return to
 * idle (a `reason: 'silence'` end), which is what happens for real speech
 * that simply continues past a minute and then actually pauses; or a
 * *second consecutive* `'max'` with no silence in between, which means the
 * environment never settled and waiting for silence would wait forever —
 * that case applies the seed immediately, so the still-elevated-energy
 * signal reads as non-speech on the next frame and the stuck utterance ends
 * (empty, dropped silently) within one more `endMs` window. Either way, a
 * stuck-classifying-as-speech mic recovers on its own, in at most two
 * `maxUtteranceMs` windows — and because the re-seed only raises the floor
 * (adaptation resumes normally from there), a few seconds of genuine
 * silence afterward decays it back down and detection of real speech
 * resumes.
 */
export class VoiceActivityDetector {
  private readonly bytesPerMs: number;
  private readonly endMs: number;
  private readonly minUtteranceMs: number;
  private readonly maxUtteranceMs: number;
  private readonly threshold: number;
  private readonly calibrationMs: number;
  private startMs: number;

  private floor = NOISE_FLOOR_INIT;
  private _speaking = false;
  // Set by a 'max' finalize. Applied at the next genuine return to idle, or
  // immediately on a second consecutive 'max' with no idle in between,
  // whichever comes first (see the class doc comment) — applying it right
  // at the first 'max' would poison the still-ongoing continuation
  // utterance's own above/below classification against its own energy.
  private pendingFloorSeed: number | null = null;

  // Calibration state.
  private calibrating: boolean;
  private calibrationMsSoFar = 0;
  private calibrationWeightedSum = 0;

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
    this.calibrationMs = opts.calibrationMs ?? DEFAULT_CALIBRATION_MS;
    this.calibrating = this.calibrationMs > 0;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  /** Overrides the startMs confirmation window from here on (options otherwise persist). */
  setStartMs(ms: number): void {
    this.startMs = ms;
  }

  /** Clears all detection state (floor, buffers, speaking) but leaves configured options.
   * Re-runs the calibration window (if `calibrationMs > 0`) before detection resumes. */
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
    this.calibrating = this.calibrationMs > 0;
    this.calibrationMsSoFar = 0;
    this.calibrationWeightedSum = 0;
    this.pendingFloorSeed = null;
  }

  push(frame: Uint8Array): VadEvent[] {
    const events: VadEvent[] = [];
    if (frame.length === 0) return events;

    const rms = rmsOf(frame);
    events.push({ type: 'level', rms });

    // An odd byte count contributes floor(n/2) samples to rms above, same
    // as before; drop that trailing byte here so it's never stored — kept
    // in a buffer, a stray unpaired byte would byte-shift every sample
    // concatenated after it for the rest of the utterance.
    const bytes = frame.length % 2 === 0 ? frame : frame.subarray(0, frame.length - 1);
    // A 1-byte frame trims to empty: its level was already emitted above,
    // but there's nothing left to classify or store. Returning here matters
    // — an empty frame reaching pushWhileIdle would otherwise discard any
    // in-progress candidate run (aboveMs > 0), letting one stray byte
    // cancel a real confirmation that was already 299ms in.
    if (bytes.length === 0) return events;

    if (this.calibrating) {
      this.pushWhileCalibrating(bytes, rms);
    } else if (this._speaking) {
      this.pushWhileSpeaking(bytes, rms, events);
    } else {
      this.pushWhileIdle(bytes, rms, events);
    }
    return events;
  }

  /** During calibration: no detection, no pre-roll — only seeds the running mean RMS. */
  private pushWhileCalibrating(bytes: Uint8Array, rms: number): void {
    const frameMs = bytes.length / this.bytesPerMs;
    this.calibrationWeightedSum += rms * frameMs;
    this.calibrationMsSoFar += frameMs;

    if (this.calibrationMsSoFar >= this.calibrationMs) {
      const mean = this.calibrationWeightedSum / this.calibrationMsSoFar;
      this.floor = Math.max(NOISE_FLOOR_MIN, mean);
      this.calibrating = false;
    }
  }

  private pushWhileIdle(bytes: Uint8Array, rms: number, events: VadEvent[]): void {
    const frameMs = bytes.length / this.bytesPerMs;
    const above = rms > this.threshold * this.floor;

    if (above) {
      if (this.aboveMs === 0) {
        this.candidateSnapshot = concatChunks(this.ring);
      }
      this.candidate.push(bytes);
      this.aboveMs += frameMs;
      this.pushToRing(bytes);

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

    // Below threshold: adapt the noise floor (time-based alpha — see
    // floorAlphaFor) and drop any failed candidate run.
    const alpha = floorAlphaFor(frameMs);
    this.floor = Math.max(NOISE_FLOOR_MIN, (1 - alpha) * this.floor + alpha * rms);
    this.pushToRing(bytes);
    if (this.aboveMs > 0) {
      this.candidate = [];
      this.candidateSnapshot = null;
      this.aboveMs = 0;
    }
  }

  private pushWhileSpeaking(bytes: Uint8Array, rms: number, events: VadEvent[]): void {
    const frameMs = bytes.length / this.bytesPerMs;
    const above = rms > this.threshold * this.floor;

    if (above) {
      if (this.trailing.length > 0) {
        const flushed = concatChunks(this.trailing);
        this.trailing = [];
        this.appendToUtterance(flushed, events);
      }
      this.belowMs = 0;
      this.appendToUtterance(bytes, events);
      return;
    }

    this.trailing.push(bytes);
    this.belowMs += frameMs;

    if (this.belowMs >= this.endMs) {
      this.finalizeUtterance('silence', events);
      // Genuine return to idle: apply any max-triggered self-heal seed now.
      if (this.pendingFloorSeed !== null) {
        this.floor = this.pendingFloorSeed;
        this.pendingFloorSeed = null;
      }
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

    if (reason === 'max') {
      // Self-heal: an utterance that only ended because it hit the hard cap
      // never saw real silence, which usually means the floor is too low
      // for this environment. Stage a re-seed from the utterance's own
      // energy — applied once detection actually returns to idle, not here,
      // since the very next frames are typically this same utterance's own
      // continuation and must not be judged against their own just-elevated
      // floor.
      //
      // But if the environment never settles (a stuck mic reading ambient
      // noise as continuous "speech" hits 'max' again without ever seeing
      // silence in between), waiting for a 'silence' finalize that will
      // never come would leave it stuck at 60s chunks forever. So a
      // *second* consecutive 'max' applies the still-pending seed from the
      // first one immediately, before staging its own — that's enough to
      // make the ongoing signal read as non-speech and let this utterance
      // end (empty, as 'silence') on the very next frame.
      if (this.pendingFloorSeed !== null) {
        this.floor = this.pendingFloorSeed;
      }
      this.pendingFloorSeed = Math.max(NOISE_FLOOR_MIN, rmsOf(pcm));
    }
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
