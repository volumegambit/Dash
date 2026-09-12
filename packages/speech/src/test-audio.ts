const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

function sampleCountFor(ms: number): number {
  return Math.round((ms * SAMPLE_RATE) / 1000);
}

function toPcm16(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

/** `ms` of digital silence as 16 kHz mono PCM16 (little-endian). */
export function silence(ms: number): Uint8Array {
  return new Uint8Array(sampleCountFor(ms) * BYTES_PER_SAMPLE);
}

/** `ms` of a pure sine tone at `hz`, `amplitude` in 0..1, as 16 kHz mono PCM16. */
export function tone(ms: number, hz: number, amplitude: number): Uint8Array {
  const n = sampleCountFor(ms);
  const samples = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return toPcm16(samples);
}

/**
 * `ms` of uniform white noise in `amplitude` (0..1), as 16 kHz mono PCM16.
 * Generated with a seeded LCG (not `Math.random`) so tests that rely on its
 * RMS are deterministic across runs.
 */
export function noise(ms: number, amplitude: number, seed = 1): Uint8Array {
  const n = sampleCountFor(ms);
  const samples = new Array<number>(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const uniform01 = state / 4294967296; // [0, 1)
    samples[i] = amplitude * (uniform01 * 2 - 1); // [-amplitude, amplitude)
  }
  return toPcm16(samples);
}
