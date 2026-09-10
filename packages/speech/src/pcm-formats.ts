export interface Pcm16Format {
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
}

/** OpenRouter's `openai/*` TTS models stream raw PCM at 24kHz mono 16-bit. */
const OPENAI_PCM16: Pcm16Format = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };

/**
 * Looks up the raw PCM stream shape for a given model id. Only `openai/*`
 * models are known to emit `pcm16`; every other provider prefix returns
 * `null` (its `synthesize` output is not a bare PCM stream we can header).
 */
export function pcmFormatFor(model: string): Pcm16Format | null {
  return model.startsWith('openai/') ? OPENAI_PCM16 : null;
}
