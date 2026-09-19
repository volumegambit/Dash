import {
  DEFAULT_SPEECH_CONFIG,
  type SpeechConfig,
  mergeSpeechConfig,
  validateSpeechConfigPatch,
} from './config.js';

describe('validateSpeechConfigPatch', () => {
  it('accepts an empty patch', () => {
    const result = validateSpeechConfigPatch({});
    expect(result.ok).toBe(true);
  });

  it('rejects non-object bodies', () => {
    for (const bad of [null, undefined, 'x', 42, true, []]) {
      const result = validateSpeechConfigPatch(bad);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an unknown top-level key, naming it', () => {
    const result = validateSpeechConfigPatch({ bogus: 1 });
    expect(result).toEqual({ ok: false, error: 'unknown key bogus' });
  });

  it('rejects an unknown nested key, naming its path', () => {
    const result = validateSpeechConfigPatch({ stt: { foo: 1 } });
    expect(result).toEqual({ ok: false, error: 'unknown key stt.foo' });
  });

  it('rejects an unknown nested tts key, naming its path', () => {
    const result = validateSpeechConfigPatch({ tts: { foo: 1 } });
    expect(result).toEqual({ ok: false, error: 'unknown key tts.foo' });
  });

  it('rejects an unknown nested realtime key, naming its path', () => {
    const result = validateSpeechConfigPatch({ realtime: { provider: 'x', foo: 1 } });
    expect(result).toEqual({ ok: false, error: 'unknown key realtime.foo' });
  });

  it('accepts a valid stt patch', () => {
    const result = validateSpeechConfigPatch({
      stt: { provider: 'openrouter', model: 'openai/whisper-large-v3', language: 'en' },
    });
    expect(result).toEqual({
      ok: true,
      patch: { stt: { provider: 'openrouter', model: 'openai/whisper-large-v3', language: 'en' } },
    });
  });

  it('accepts a valid tts patch', () => {
    const result = validateSpeechConfigPatch({
      tts: {
        provider: 'openrouter',
        model: 'minimax/speech-2.8-turbo',
        voice: 'alloy',
        speed: 1.5,
      },
    });
    expect(result).toEqual({
      ok: true,
      patch: {
        tts: {
          provider: 'openrouter',
          model: 'minimax/speech-2.8-turbo',
          voice: 'alloy',
          speed: 1.5,
        },
      },
    });
  });

  it('accepts a valid realtime patch with a string provider', () => {
    const result = validateSpeechConfigPatch({ realtime: { provider: 'openai' } });
    expect(result).toEqual({ ok: true, patch: { realtime: { provider: 'openai' } } });
  });

  it('accepts a valid realtime patch with a null provider', () => {
    const result = validateSpeechConfigPatch({ realtime: { provider: null } });
    expect(result).toEqual({ ok: true, patch: { realtime: { provider: null } } });
  });

  it('rejects a realtime patch missing provider', () => {
    const result = validateSpeechConfigPatch({ realtime: {} });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty string for provider', () => {
    const result = validateSpeechConfigPatch({ stt: { provider: '' } });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-string provider', () => {
    const result = validateSpeechConfigPatch({ stt: { provider: 5 } });
    expect(result.ok).toBe(false);
  });

  it('accepts a string exactly at the 200-char limit', () => {
    const model = 'a'.repeat(200);
    const result = validateSpeechConfigPatch({ stt: { model } });
    expect(result).toEqual({ ok: true, patch: { stt: { model } } });
  });

  it('rejects a string one over the 200-char limit', () => {
    const model = 'a'.repeat(201);
    const result = validateSpeechConfigPatch({ stt: { model } });
    expect(result.ok).toBe(false);
  });

  it('accepts language at the 2-char lower boundary', () => {
    const result = validateSpeechConfigPatch({ stt: { language: 'en' } });
    expect(result).toEqual({ ok: true, patch: { stt: { language: 'en' } } });
  });

  it('accepts language at the 8-char upper boundary', () => {
    const result = validateSpeechConfigPatch({ stt: { language: 'en-SG-xx' } });
    expect(result).toEqual({ ok: true, patch: { stt: { language: 'en-SG-xx' } } });
  });

  it('rejects language below 2 chars', () => {
    const result = validateSpeechConfigPatch({ stt: { language: 'e' } });
    expect(result.ok).toBe(false);
  });

  it('rejects language above 8 chars', () => {
    const result = validateSpeechConfigPatch({ stt: { language: 'en-SG-xxx' } });
    expect(result.ok).toBe(false);
  });

  // The one way a client can go back to provider auto-detect: an omitted key
  // means "leave it alone", so "clear it" has to be a value.
  it('accepts an explicit null language, meaning clear it', () => {
    const result = validateSpeechConfigPatch({ stt: { language: null } });
    expect(result).toEqual({ ok: true, patch: { stt: { language: null } } });
  });

  it('still rejects a non-string, non-null language', () => {
    const result = validateSpeechConfigPatch({ stt: { language: 17 } });
    expect(result.ok).toBe(false);
  });

  it('accepts a patch that omits language', () => {
    const result = validateSpeechConfigPatch({ stt: { provider: 'openrouter' } });
    expect(result).toEqual({ ok: true, patch: { stt: { provider: 'openrouter' } } });
  });

  it('accepts speed at the 0.25 lower boundary', () => {
    const result = validateSpeechConfigPatch({ tts: { speed: 0.25 } });
    expect(result).toEqual({ ok: true, patch: { tts: { speed: 0.25 } } });
  });

  it('accepts speed at the 4 upper boundary', () => {
    const result = validateSpeechConfigPatch({ tts: { speed: 4 } });
    expect(result).toEqual({ ok: true, patch: { tts: { speed: 4 } } });
  });

  it('rejects speed just above the 4 upper boundary', () => {
    const result = validateSpeechConfigPatch({ tts: { speed: 4.01 } });
    expect(result.ok).toBe(false);
  });

  it('rejects speed just below the 0.25 lower boundary', () => {
    const result = validateSpeechConfigPatch({ tts: { speed: 0.24 } });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-finite speed', () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = validateSpeechConfigPatch({ tts: { speed: bad } });
      expect(result.ok).toBe(false);
    }
  });

  it('ignores a key explicitly set to undefined', () => {
    const result = validateSpeechConfigPatch({
      stt: { provider: 'openrouter', language: undefined },
    });
    expect(result).toEqual({ ok: true, patch: { stt: { provider: 'openrouter' } } });
  });

  it('validates DEFAULT_SPEECH_CONFIG against itself', () => {
    const result = validateSpeechConfigPatch(DEFAULT_SPEECH_CONFIG);
    expect(result.ok).toBe(true);
  });
});

describe('mergeSpeechConfig', () => {
  const base: SpeechConfig = {
    stt: { provider: 'openrouter', model: 'openai/whisper-large-v3', language: 'en' },
    tts: {
      provider: 'openrouter',
      model: 'minimax/speech-2.8-turbo',
      voice: 'English_expressive_narrator',
    },
    realtime: { provider: null },
  };

  it('keeps untouched fields when the patch is empty', () => {
    const merged = mergeSpeechConfig(base, {});
    expect(merged).toEqual(base);
  });

  it('applies a partial stt patch without disturbing tts or realtime', () => {
    const merged = mergeSpeechConfig(base, { stt: { model: 'openai/whisper-large-v3-turbo' } });
    expect(merged.stt).toEqual({
      provider: 'openrouter',
      model: 'openai/whisper-large-v3-turbo',
      language: 'en',
    });
    expect(merged.tts).toEqual(base.tts);
    expect(merged.realtime).toEqual(base.realtime);
  });

  it('applies a partial tts patch, keeping unset fields', () => {
    const merged = mergeSpeechConfig(base, { tts: { speed: 1.2 } });
    expect(merged.tts).toEqual({ ...base.tts, speed: 1.2 });
  });

  it('applies a realtime patch', () => {
    const merged = mergeSpeechConfig(base, { realtime: { provider: 'openai' } });
    expect(merged.realtime).toEqual({ provider: 'openai' });
  });

  it('never drops a stored field via an undefined patch key', () => {
    const merged = mergeSpeechConfig(base, { stt: { language: undefined } });
    expect(merged.stt.language).toBe('en');
  });

  it('deletes the language on an explicit null, rather than storing null', () => {
    const merged = mergeSpeechConfig(base, { stt: { language: null } });
    expect(merged.stt.language).toBeUndefined();
    expect('language' in merged.stt).toBe(false);
    // Only the language: the rest of the section is untouched.
    expect(merged.stt.provider).toBe(base.stt.provider);
    expect(merged.stt.model).toBe(base.stt.model);
  });

  it('does not mutate the base config', () => {
    const snapshot = JSON.parse(JSON.stringify(base));
    mergeSpeechConfig(base, { stt: { model: 'changed' } });
    expect(base).toEqual(snapshot);
  });
});
