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

/**
 * Models that reject `response_format: mp3` outright and only ever return
 * PCM (Google's Gemini TTS, per the Task A12 live probe). Disjoint from
 * {@link PCM16_MODELS}: that table is models with a *known static* PCM
 * sample rate; these are models where PCM is the *only* option, whatever
 * rate they happen to declare in the response content-type.
 */
export const PCM_ONLY_MODELS: ReadonlySet<string> = new Set([
  'google/gemini-3.1-flash-tts-preview',
]);

/**
 * Parses OpenRouter's declared PCM content-type, e.g.
 * `audio/pcm;rate=24000;channels=1`. Case-insensitive on the media type and
 * parameter names; tolerates spaces around `;` and `=`. Returns `null` for
 * any other media type, a missing/non-positive-integer `rate`, a missing
 * `channels`, or `channels !== 1`.
 */
export function parsePcmContentType(contentType: string | null | undefined): Pcm16Format | null {
  if (!contentType) return null;

  const parts = contentType.split(';').map((part) => part.trim());
  const mediaType = parts[0]?.toLowerCase();
  if (mediaType !== 'audio/pcm') return null;

  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    params[key] = value;
  }

  const rateParam = params.rate;
  if (!rateParam || !/^\d+$/.test(rateParam)) return null;
  const sampleRate = Number(rateParam);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) return null;

  const channelsParam = params.channels;
  if (channelsParam !== '1') return null;

  return { sampleRate, channels: 1, bitsPerSample: 16 };
}

/**
 * Resolves which `response_format` to actually request from the provider
 * for `model`, given what the caller `wanted`:
 * - `pcm16` wanted: stays `pcm16` if the model is on the static PCM
 *   allow-list or is PCM-only; otherwise downgrades to `mp3`.
 * - `mp3` wanted: upgrades to `pcm16` if the model is PCM-only (it would
 *   otherwise reject the `mp3` request); otherwise stays `mp3`.
 */
export function speechRequestFormat(model: string, wanted: 'pcm16' | 'mp3'): 'pcm16' | 'mp3' {
  if (wanted === 'pcm16') {
    return pcmFormatFor(model) !== null || PCM_ONLY_MODELS.has(model) ? 'pcm16' : 'mp3';
  }
  return PCM_ONLY_MODELS.has(model) ? 'pcm16' : 'mp3';
}
