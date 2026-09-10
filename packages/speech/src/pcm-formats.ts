export interface Pcm16Format {
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
}

const PCM16_24K: Pcm16Format = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };

/**
 * OpenRouter's `audio/pcm` responses declare `rate=` and `channels=` in the
 * content-type; this table is the static allow-list of models known to
 * accept `response_format: pcm` — MiniMax and Gemini do not (MiniMax is
 * MP3-only, Gemini is PCM-only).
 */
export const PCM16_MODELS: ReadonlyMap<string, Pcm16Format> = new Map([
  ['hexgrad/kokoro-82m', PCM16_24K],
  ['microsoft/mai-voice-2-flash', PCM16_24K],
  ['microsoft/mai-voice-2', PCM16_24K],
]);

/** Looks up the raw PCM stream shape for a given model id, or `null` if unknown. */
export function pcmFormatFor(model: string): Pcm16Format | null {
  return PCM16_MODELS.get(model) ?? null;
}
