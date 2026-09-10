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
    // calibrationMs: 0 — this test is about startMs, not calibration; without
    // it the entire 200ms burst would fall inside the default 500ms
    // calibration window and never reach detection at all.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    const events = vad.push(tone(200, 440, 0.5));

    expect(byType(events, 'speech_start')).toHaveLength(0);
    expect(vad.speaking).toBe(false);
  });

  it('starts and ends an utterance around a tone, keeping ~300ms pre-roll', () => {
    // calibrationMs: 0 — this test is about pre-roll/end-trim byte math, not
    // calibration; the calibration window would otherwise eat the first
    // 500ms of the leading silence without feeding the pre-roll ring.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });

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
    // calibrationMs: 0 — this test is about EMA drift, not calibration.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    const events = pushAll(vad, tone(1000, 440, 0.0007));
    expect(byType(events, 'speech_start')).toHaveLength(1);
  });

  it('adapts the noise floor to a quiet hum: a mid tone no longer starts speech, a loud one still does', () => {
    // calibrationMs: 0 — this test targets the EMA drift path specifically
    // (as opposed to the one-shot calibration seed, covered separately below).
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });

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
    // calibrationMs: 0 — with default calibration on, the tone itself would
    // become the calibration signal for its first 500ms, seeding the floor
    // from its own ~0.35 rms; 3x that exceeds the maximum possible rms
    // (1.0), so the tone could never be classified as speech at all. This
    // test is about the max cutoff, not calibration, so it opts out.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
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
    // calibrationMs: 0 — this test targets reset()'s effect on the EMA-adapted
    // floor specifically; calibration-seeding is covered by its own tests below.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });

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
    // calibrationMs: 0 — this test is about startMs, not calibration.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    vad.setStartMs(400);

    const events = vad.push(tone(350, 440, 0.5));
    expect(byType(events, 'speech_start')).toHaveLength(0);
    expect(vad.speaking).toBe(false);
  });

  it('drops an utterance shorter than minUtteranceMs silently (no speech_end)', () => {
    // calibrationMs: 0 — this test is about minUtteranceMs, not calibration;
    // the abrupt 400ms burst below would otherwise fall inside the default
    // 500ms calibration window and never even attempt detection.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });

    // An abrupt 400ms burst (no pre-roll, since nothing preceded it) starts
    // speech but never reaches minUtteranceMs (500ms) once silence ends it.
    const startEvents = vad.push(tone(400, 440, 0.5));
    expect(byType(startEvents, 'speech_start')).toHaveLength(1);

    const endEvents = vad.push(silence(700));
    expect(byType(endEvents, 'speech_end')).toHaveLength(0);
    expect(vad.speaking).toBe(false);
  });

  it('calibrates the floor from 500ms of ambient hum, so a tone that would start speech cold no longer does', () => {
    // Default calibrationMs (500). The first 500ms of pushed audio only
    // seeds the floor — no detection, no pre-roll. Captured (not discarded)
    // so we can prove the hum itself never starts speech: if calibration
    // were disabled, this hum (rms ~0.0115) would clear the cold 3e-4
    // threshold from frame 1 and the detector would already be speaking by
    // the time the probe tone below runs, making that assertion pass for
    // the wrong reason (continuation, not "no new start").
    const hummed = new VoiceActivityDetector();
    const humEvents = pushAll(hummed, noise(500, 0.02, 5));
    expect(byType(humEvents, 'speech_start')).toHaveLength(0);
    expect(hummed.speaking).toBe(false);

    const afterHum = pushAll(hummed, tone(500, 440, 0.03));
    expect(byType(afterHum, 'speech_start')).toHaveLength(0);

    // Same tone, but calibrated against 500ms of silence instead: the floor
    // seeds at the 1e-4 minimum, and the tone clears 3x that easily — this
    // is what proves the hum's own energy (not just "calibration happened")
    // is what raised the floor above.
    const quiet = new VoiceActivityDetector();
    pushAll(quiet, silence(500));
    const afterSilence = pushAll(quiet, tone(500, 440, 0.03));
    expect(byType(afterSilence, 'speech_start')).toHaveLength(1);
  });

  it('calibrationMs: 0 restores immediate cold-start detection', () => {
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    // Well above both startMs (300ms) and the cold 1e-4 floor — with
    // calibration disabled this starts speech immediately, matching
    // pre-calibration behaviour (no leading window of any kind).
    const events = pushAll(vad, tone(400, 440, 0.5));
    expect(byType(events, 'speech_start')).toHaveLength(1);
  });

  it('re-seeds the noise floor after a max cutoff, recovering a stuck-classifying-as-speech mic', () => {
    // calibrationMs: 0 so the loud tone below doesn't poison its own
    // calibration window (see the max-cutoff test's comment above) — this
    // test is specifically about the max-triggered self-heal, not calibration.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });

    // 61s of tone hits the max cutoff once, which re-seeds the floor from
    // that utterance's own rms (~0.354 for a 0.5-amplitude sine). The
    // second (continuation) utterance is still open at 1s in; let it end
    // normally on trailing silence.
    pushAll(vad, tone(61_000, 440, 0.5));
    pushAll(vad, silence(700));
    expect(vad.speaking).toBe(false);

    // A tone at the exact same amplitude that started speech cold now
    // cannot: 3x the re-seeded floor (~1.06) exceeds the maximum possible
    // rms (1.0), so nothing at this level can ever clear it again.
    const events = pushAll(vad, tone(500, 440, 0.5));
    expect(byType(events, 'speech_start')).toHaveLength(0);

    // Detection resumes: the re-seed only ever raises the floor, so genuine
    // silence afterward decays it back down (time-based EMA, ~0.95^(t/20))
    // — 2s of silence takes it from ~0.354 down to ~0.0021, well under
    // 1/3 of the original tone's amplitude again. The same tone that just
    // failed to start speech now starts and ends normally.
    pushAll(vad, silence(2000));
    const resumed = pushAll(vad, new Uint8Array([...tone(1000, 440, 0.5), ...silence(700)]));
    expect(byType(resumed, 'speech_start')).toHaveLength(1);
    const resumedEnds = byType(resumed, 'speech_end');
    expect(resumedEnds).toHaveLength(1);
    expect(resumedEnds[0].reason).toBe('silence');
  });

  it('self-heals a stuck mic that never sees silence: a second consecutive max applies the re-seed', () => {
    // calibrationMs: 0 — same reasoning as the max-cutoff test above.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });

    // Ambient "speech" that never stops: 121s of tone hits max twice
    // (at 60s and 120s) with no silence in between. The first max only
    // stages a re-seed; the second applies it immediately (nothing else
    // would ever return this detector to idle), so the still-ongoing tone
    // reads as non-speech on the next frame and the stuck utterance ends
    // (empty, dropped silently) well before the input runs out.
    const events = pushAll(vad, tone(121_000, 440, 0.5));

    const ends = byType(events, 'speech_end');
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => e.reason === 'max')).toBe(true);
    expect(vad.speaking).toBe(false);

    // Recovered: the same tone that started speech cold no longer does.
    const after = pushAll(vad, tone(500, 440, 0.5));
    expect(byType(after, 'speech_start')).toHaveLength(0);

    // Detection resumes after real silence, same as the single-max case.
    pushAll(vad, silence(2000));
    const resumed = pushAll(vad, new Uint8Array([...tone(1000, 440, 0.5), ...silence(700)]));
    expect(byType(resumed, 'speech_start')).toHaveLength(1);
    const resumedEnds = byType(resumed, 'speech_end');
    expect(resumedEnds).toHaveLength(1);
    expect(resumedEnds[0].reason).toBe('silence');
  });

  /**
   * Seeds a fresh, idle detector's floor to a known, chunking-independent
   * value: a 60s tone is pushed as one atomic frame (so it hits the max
   * cutoff and self-heal immediately, deterministically, regardless of how
   * *other* tests chunk their pushes), then enough silence (also one
   * atomic frame) to let the continuation utterance end and apply the
   * staged re-seed. The result is `floor ~= rms(tone(60000, 440, amp))`
   * (~0.3536 for amp 0.5) with the detector idle and ready.
   */
  function seededVad(amp: number): VoiceActivityDetector {
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    vad.push(tone(60_000, 440, amp));
    vad.push(silence(750));
    return vad;
  }

  it('the noise floor EMA is time-based: 20ms and 100ms frame chunking converge to the same value over the same elapsed time', () => {
    // Two independently seeded detectors (floor ~0.3536, idle) decay toward
    // the same 5s quiet hum (rms ~2.3e-4) — one fed as 20ms frames (250
    // calls), the other as 100ms frames (50 calls). A flat per-call alpha
    // (the bug this guards against) would leave the 100ms run's floor far
    // short of convergence (~0.0274, retaining ~7.7% of the original
    // 0.3536 gap) while the 20ms run is already essentially fully
    // converged (~2.3e-4) — over 100x apart. With the time-based alpha,
    // both land within a fraction of a percent of each other (verified
    // analytically: (1 - alpha(100ms))^50 === (1 - alpha(20ms))^250 exactly,
    // since both equal 0.95^250).
    const hum = noise(5000, 0.0004, 9);
    const vad20 = seededVad(0.5);
    const vad100 = seededVad(0.5);
    pushAll(vad20, hum, 20);
    pushAll(vad100, hum, 100);

    // Probe rms (~0.0141) sits strictly between 3x the converged floor
    // (~6.9e-4) and 3x what an unfixed 100ms run would leave (~0.082) — see
    // the report for the derivation — so it discriminates the bug cleanly:
    // both chunkings must agree for this to pass.
    const probe = tone(1000, 440, 0.02);
    const events20 = vad20.push(probe);
    const events100 = vad100.push(probe);
    expect(byType(events20, 'speech_start')).toHaveLength(1);
    expect(byType(events100, 'speech_start')).toHaveLength(1);
  });

  it('drops a trailing odd byte from the stored pcm, not just from the rms sample count', () => {
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    const oddFrame = tone(20, 440, 0.5).subarray(0, 33); // 33 bytes: 16 full samples + 1 stray byte
    expect(oddFrame.length % 2).toBe(1);

    // Push the odd frame as its own atomic call (not through pushAll's
    // fixed-size chunker, which would hide the one-off odd length), then
    // continue normally so the utterance actually completes.
    const events: VadEvent[] = [...vad.push(oddFrame)];
    events.push(...pushAll(vad, new Uint8Array([...tone(1000, 440, 0.5), ...silence(700)])));

    const ends = byType(events, 'speech_end');
    expect(ends).toHaveLength(1);
    // Every frame's pcm contribution is byte-paired; a kept stray byte
    // would make this odd and byte-shift every sample after it. If the
    // trailing byte weren't dropped, this would be 33 + 32000 = 32033
    // (odd) instead of 32 + 32000 = 32032 (even).
    expect(ends[0].pcm.length % 2).toBe(0);
    expect(ends[0].pcm.length).toBe(32 + 1000 * BYTES_PER_MS);
  });

  it('cuts a 61s tone at exactly maxUtteranceMs on a non-frame-aligned 7ms grid', () => {
    // 7ms (224B) frames don't evenly divide 60000ms*32B/ms = 1,920,000B
    // (1_920_000 / 224 = 8571.43), so the byte that crosses the max
    // boundary lands mid-frame (at frame 8572: head 96B, tail 128B) —
    // exercising the split branch of appendToUtterance that every
    // 20ms-aligned test in this file sidesteps entirely.
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    const events = pushAll(vad, tone(61_000, 440, 0.5), 7);

    // The cut is byte-exact by construction (appendToUtterance slices at
    // precisely maxUtteranceMs * bytesPerMs regardless of frame alignment),
    // so these are exact values, not approximations within a tolerance.
    const starts = byType(events, 'speech_start');
    const ends = byType(events, 'speech_end');
    expect(starts).toHaveLength(2); // the second start proves the tail (128B) was carried over
    expect(ends).toHaveLength(1);
    expect(ends[0].reason).toBe('max');
    expect(ends[0].durationMs).toBe(60_000);
    expect(ends[0].pcm.length).toBe(60_000 * BYTES_PER_MS);
  });

  it('a 1-byte frame trims to empty and does not cancel an in-progress candidate run', () => {
    const vad = new VoiceActivityDetector({ calibrationMs: 0 });
    const before = vad.push(tone(200, 440, 0.5)); // 200ms into the 300ms startMs window
    expect(byType(before, 'speech_start')).toHaveLength(0);

    const strayByte = vad.push(new Uint8Array(1));
    expect(byType(strayByte, 'level')).toHaveLength(1); // level is still emitted
    expect(byType(strayByte, 'speech_start')).toHaveLength(0);

    // The remaining 100ms completes startMs (300ms total): if the stray
    // byte had reset aboveMs, this would need another 300ms to confirm.
    const after = vad.push(tone(100, 440, 0.5));
    expect(byType(after, 'speech_start')).toHaveLength(1);
  });
});
