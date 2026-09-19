export interface SpeechConfig {
  stt: { provider: string; model: string; language?: string };
  tts: { provider: string; model: string; voice: string; speed?: number };
  realtime: { provider: string | null };
}

export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  stt: { provider: 'openrouter', model: 'openai/whisper-large-v3' },
  tts: {
    provider: 'openrouter',
    model: 'minimax/speech-2.8-turbo',
    voice: 'English_expressive_narrator',
  },
  realtime: { provider: null },
};

export interface SpeechConfigPatch {
  /**
   * `language: null` is a real value meaning "clear it" — the only way back to
   * provider auto-detect, since an omitted key means "leave it alone" and
   * `SpeechConfig.stt.language` is absent when auto. Deliberately spelled out
   * rather than `Partial<SpeechConfig['stt']>`, which cannot express it.
   */
  stt?: { provider?: string; model?: string; language?: string | null };
  tts?: Partial<SpeechConfig['tts']>;
  realtime?: { provider: string | null };
}

export type ValidationResult =
  | { ok: true; patch: SpeechConfigPatch }
  | { ok: false; error: string };

const STT_KEYS = ['provider', 'model', 'language'] as const;
const TTS_KEYS = ['provider', 'model', 'voice', 'speed'] as const;
const REALTIME_KEYS = ['provider'] as const;
const TOP_KEYS = ['stt', 'tts', 'realtime'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function isValidLanguage(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= 8;
}

function isValidSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4;
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return `unknown key ${prefix}${key}`;
    }
  }
  return null;
}

function validateSttPatch(
  raw: unknown,
): { ok: true; value: SpeechConfigPatch['stt'] } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'stt must be an object' };
  }
  const unknown = checkUnknownKeys(raw, STT_KEYS, 'stt.');
  if (unknown) {
    return { ok: false, error: unknown };
  }

  const value: NonNullable<SpeechConfigPatch['stt']> = {};

  if (raw.provider !== undefined) {
    if (!isNonEmptyShortString(raw.provider)) {
      return {
        ok: false,
        error: 'stt.provider must be a non-empty string of at most 200 characters',
      };
    }
    value.provider = raw.provider;
  }
  if (raw.model !== undefined) {
    if (!isNonEmptyShortString(raw.model)) {
      return { ok: false, error: 'stt.model must be a non-empty string of at most 200 characters' };
    }
    value.model = raw.model;
  }
  if (raw.language !== undefined) {
    // `null` clears the language; every other non-string, and an out-of-range
    // string, is still a 400. Mirrors `realtime.provider`: a nullable field
    // whose null is a value, not an absence.
    if (raw.language !== null && !isValidLanguage(raw.language)) {
      return { ok: false, error: 'stt.language must be 2-8 characters or null' };
    }
    value.language = raw.language as string | null;
  }

  return { ok: true, value };
}

function validateTtsPatch(
  raw: unknown,
): { ok: true; value: SpeechConfigPatch['tts'] } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'tts must be an object' };
  }
  const unknown = checkUnknownKeys(raw, TTS_KEYS, 'tts.');
  if (unknown) {
    return { ok: false, error: unknown };
  }

  const value: NonNullable<SpeechConfigPatch['tts']> = {};

  if (raw.provider !== undefined) {
    if (!isNonEmptyShortString(raw.provider)) {
      return {
        ok: false,
        error: 'tts.provider must be a non-empty string of at most 200 characters',
      };
    }
    value.provider = raw.provider;
  }
  if (raw.model !== undefined) {
    if (!isNonEmptyShortString(raw.model)) {
      return { ok: false, error: 'tts.model must be a non-empty string of at most 200 characters' };
    }
    value.model = raw.model;
  }
  if (raw.voice !== undefined) {
    if (!isNonEmptyShortString(raw.voice)) {
      return { ok: false, error: 'tts.voice must be a non-empty string of at most 200 characters' };
    }
    value.voice = raw.voice;
  }
  if (raw.speed !== undefined) {
    if (!isValidSpeed(raw.speed)) {
      return { ok: false, error: 'tts.speed must be a finite number between 0.25 and 4' };
    }
    value.speed = raw.speed;
  }

  return { ok: true, value };
}

function validateRealtimePatch(
  raw: unknown,
): { ok: true; value: SpeechConfigPatch['realtime'] } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'realtime must be an object' };
  }
  const unknown = checkUnknownKeys(raw, REALTIME_KEYS, 'realtime.');
  if (unknown) {
    return { ok: false, error: unknown };
  }
  if (!('provider' in raw)) {
    return { ok: false, error: 'realtime.provider is required' };
  }
  const provider = raw.provider;
  if (provider !== null && !isNonEmptyShortString(provider)) {
    return { ok: false, error: 'realtime.provider must be a string or null' };
  }

  return { ok: true, value: { provider } };
}

export function validateSpeechConfigPatch(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'body must be an object' };
  }

  const unknown = checkUnknownKeys(raw, TOP_KEYS, '');
  if (unknown) {
    return { ok: false, error: unknown };
  }

  const patch: SpeechConfigPatch = {};

  if (raw.stt !== undefined) {
    const result = validateSttPatch(raw.stt);
    if (!result.ok) {
      return result;
    }
    patch.stt = result.value;
  }

  if (raw.tts !== undefined) {
    const result = validateTtsPatch(raw.tts);
    if (!result.ok) {
      return result;
    }
    patch.tts = result.value;
  }

  if (raw.realtime !== undefined) {
    const result = validateRealtimePatch(raw.realtime);
    if (!result.ok) {
      return result;
    }
    patch.realtime = result.value;
  }

  return { ok: true, patch };
}

export function mergeSpeechConfig(base: SpeechConfig, patch: SpeechConfigPatch): SpeechConfig {
  const merged: SpeechConfig = {
    stt: { ...base.stt },
    tts: { ...base.tts },
    realtime: { ...base.realtime },
  };

  if (patch.stt) {
    if (patch.stt.provider !== undefined) merged.stt.provider = patch.stt.provider;
    if (patch.stt.model !== undefined) merged.stt.model = patch.stt.model;
    if (patch.stt.language !== undefined) {
      // The one key a patch can REMOVE: `stt.language` is ABSENT when the
      // provider auto-detects, so "set it to auto" drops the key rather than
      // writing a value. Rebuilt without it rather than `delete`d (biome's
      // `noDelete`) and rather than assigned `undefined`, which would leave
      // the key present for `in` and `Object.keys`.
      if (patch.stt.language === null) {
        const { language: _cleared, ...withoutLanguage } = merged.stt;
        merged.stt = withoutLanguage;
      } else {
        merged.stt.language = patch.stt.language;
      }
    }
  }

  if (patch.tts) {
    if (patch.tts.provider !== undefined) merged.tts.provider = patch.tts.provider;
    if (patch.tts.model !== undefined) merged.tts.model = patch.tts.model;
    if (patch.tts.voice !== undefined) merged.tts.voice = patch.tts.voice;
    if (patch.tts.speed !== undefined) merged.tts.speed = patch.tts.speed;
  }

  if (patch.realtime !== undefined && patch.realtime.provider !== undefined) {
    merged.realtime.provider = patch.realtime.provider;
  }

  return merged;
}
