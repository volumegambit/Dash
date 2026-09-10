import { noise, silence, tone } from './test-audio.js';
import { type VadEvent, VoiceActivityDetector } from './vad.js';

const BYTES_PER_MS = 32; // 16 kHz, mono, 16-bit PCM

/** Feeds `pcm` into `vad` in `frameMs`-sized chunks, collecting every event in order. */
function pushAll(vad: VoiceActivityDetector, pcm: Uint8Array, frameMs = 20): VadEvent[] {
  const frameBytes = frameMs * BYTES_PER_MS;
  const events: VadEvent[] = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    events.push(...vad.push(pcm.subarray(offset, offset + frameBytes)));
  }
  return events;
}

function byType<T extends VadEvent['type']>(
  events: VadEvent[],
  type: T,
): Extract<VadEvent, { type: T }>[] {
  return events.filter((e): e is Extract<VadEvent, { type: T }> => e.type === type);
}

describe('VoiceActivityDetector', () => {
  it('emits no speech events for pure silence, only level events at rms 0', () => {
    const vad = new VoiceActivityDetector();
    const events = pushAll(vad, silence(1000));

    expect(byType(events, 'speech_start')).toHaveLength(0);
    expect(byType(events, 'speech_end')).toHaveLength(0);
    const levels = byType(events, 'level');
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) expect(level.rms).toBe(0);
    expect(vad.speaking).toBe(false);
  });

  it('does not start speech for a 200ms tone (shorter than startMs)', () => {
    const vad = new VoiceActivityDetector();
    const events = vad.push(tone(200, 440, 0.5));

    expect(byType(events, 'speech_start')).toHaveLength(0);
    expect(vad.speaking).toBe(false);
  });

  it('starts and ends an utterance around a tone, keeping ~300ms pre-roll', () => {
    const vad = new VoiceActivityDetector();

    // 300ms of leading silence establishes a full pre-roll window before the
    // tone begins, so speech_start's utterance provably includes it.
    const events = pushAll(
      vad,
      new Uint8Array([...silence(300), ...tone(1000, 440, 0.5), ...silence(700)]),
    );

    expect(byType(events, 'speech_start')).toHaveLength(1);
    const ends = byType(events, 'speech_end');
    expect(ends).toHaveLength(1);
    const [end] = ends;
    expect(end.reason).toBe('silence');

    // 300ms pre-roll + 1000ms tone = 1300ms, all captured before the 700ms
    // of trailing silence used only to confirm the end (and then dropped).
    expect(end.durationMs).toBeGreaterThanOrEqual(1300 - 100);
    expect(end.durationMs).toBeLessThanOrEqual(1300 + 100);
    expect(end.pcm.length).toBe(1300 * BYTES_PER_MS);

    // The first 300ms of the captured pcm is the pre-roll: silence.
    const preroll = end.pcm.subarray(0, 300 * BYTES_PER_MS);
    expect(preroll.every((b) => b === 0)).toBe(true);
    // Immediately after, the tone's onset is present (non-zero bytes).
    const onset = end.pcm.subarray(300 * BYTES_PER_MS, 300 * BYTES_PER_MS + BYTES_PER_MS * 20);
    expect(onset.some((b) => b !== 0)).toBe(true);

    expect(vad.speaking).toBe(false);
  });

  it('the same mid-volume tone starts speech against a cold (unadapted) floor', () => {
    // Baseline for the drift test below: this exact tone clears 3x the
    // initial 1e-4 floor (rms ~4.95e-4 > 3e-4) when nothing has adapted it.
    const vad = new VoiceActivityDetector();
    const events = pushAll(vad, tone(1000, 440, 0.0007));
    expect(byType(events, 'speech_start')).toHaveLength(1);
  });

  it('adapts the noise floor to a quiet hum: a mid tone no longer starts speech, a loud one still does', () => {
    const vad = new VoiceActivityDetector();

    // Hum RMS (~2.3e-4) is deliberately below the initial 3x threshold over
    // the 1e-4 floor (3e-4), so it's classified as non-speech from the start
    // and the floor adapts toward it over many small frames (5s chunked
    // into 20ms pieces so the EMA actually iterates rather than taking one
    // giant step).
    const humEvents = pushAll(vad, noise(5000, 0.0004, 7));
    expect(byType(humEvents, 'speech_start')).toHaveLength(0);

    // The exact tone that starts speech cold (previous test) does NOT once
    // the floor has adapted toward the hum (rms ~4.95e-4 < 3 * ~2.3e-4 =
    // ~6.9e-4) — this is what actually proves the floor moved, rather than
    // merely staying frozen at its initial value.
    const midEvents = pushAll(vad, tone(1000, 440, 0.0007));
    expect(byType(midEvents, 'speech_start')).toHaveLength(0);
    expect(vad.speaking).toBe(false);

    // A tone loud enough to clear even the adapted floor still starts speech.
    const loudEvents = pushAll(vad, tone(1000, 440, 0.5));
    expect(byType(loudEvents, 'speech_start')).toHaveLength(1);
    expect(vad.speaking).toBe(true);
  });

  it('cuts a 61s tone at exactly maxUtteranceMs and continues as a new utterance', () => {
    const vad = new VoiceActivityDetector();
    const events = pushAll(vad, tone(61_000, 440, 0.5));

    const starts = byType(events, 'speech_start');
    const ends = byType(events, 'speech_end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(1);
    expect(ends[0].reason).toBe('max');
    expect(ends[0].durationMs).toBe(60_000);
    expect(ends[0].pcm.length).toBe(60_000 * BYTES_PER_MS);

    // Still speaking: the remaining 1s of tone became the second utterance,
    // which never hit silence, so it has no speech_end yet.
    expect(vad.speaking).toBe(true);
  });

  it('reset() clears speaking state and the adapted noise floor', () => {
    const vad = new VoiceActivityDetector();

    // Adapt the floor upward with the same hum used in the drift test above.
    pushAll(vad, noise(5000, 0.0004, 7));
    const beforeReset = pushAll(vad, tone(1000, 440, 0.0007));
    expect(byType(beforeReset, 'speech_start')).toHaveLength(0);

    vad.reset();
    expect(vad.speaking).toBe(false);

    // Same tone now clears 3x the reset floor (1e-4), proving the floor
    // really was reset rather than merely retained.
    const afterReset = pushAll(vad, tone(1000, 440, 0.0007));
    expect(byType(afterReset, 'speech_start')).toHaveLength(1);
  });

  it('setStartMs(400) requires a longer sustained run before starting speech', () => {
    const vad = new VoiceActivityDetector();
    vad.setStartMs(400);

    const events = vad.push(tone(350, 440, 0.5));
    expect(byType(events, 'speech_start')).toHaveLength(0);
    expect(vad.speaking).toBe(false);
  });

  it('drops an utterance shorter than minUtteranceMs silently (no speech_end)', () => {
    const vad = new VoiceActivityDetector();

    // An abrupt 400ms burst (no pre-roll, since nothing preceded it) starts
    // speech but never reaches minUtteranceMs (500ms) once silence ends it.
    const startEvents = vad.push(tone(400, 440, 0.5));
    expect(byType(startEvents, 'speech_start')).toHaveLength(1);

    const endEvents = vad.push(silence(700));
    expect(byType(endEvents, 'speech_end')).toHaveLength(0);
    expect(vad.speaking).toBe(false);
  });
});
