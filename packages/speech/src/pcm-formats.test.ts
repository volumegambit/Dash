import {
  PCM16_MODELS,
  PCM_ONLY_MODELS,
  parsePcmContentType,
  pcmFormatFor,
  speechRequestFormat,
} from './pcm-formats.js';

describe('pcmFormatFor', () => {
  it.each([...PCM16_MODELS.keys()])('returns 24kHz mono 16-bit PCM for %s', (model) => {
    expect(pcmFormatFor(model)).toEqual({
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
    });
  });

  it('returns null for the MiniMax default (MP3-only)', () => {
    expect(pcmFormatFor('minimax/speech-2.8-turbo')).toBeNull();
  });

  it('returns null for a non-existent openai/* model id', () => {
    expect(pcmFormatFor('openai/gpt-4o-mini-tts-2025-12-15')).toBeNull();
  });

  it('returns null for any other openai/* model id', () => {
    expect(pcmFormatFor('openai/anything')).toBeNull();
  });
});

describe('parsePcmContentType', () => {
  it('parses the exact header OpenRouter declares', () => {
    expect(parsePcmContentType('audio/pcm;rate=24000;channels=1')).toEqual({
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
    });
  });

  it('is case-insensitive and tolerates spaces around ; and =', () => {
    expect(parsePcmContentType('AUDIO/PCM; RATE = 22050; CHANNELS = 1')).toEqual({
      sampleRate: 22050,
      channels: 1,
      bitsPerSample: 16,
    });
  });

  it('returns null for a non-pcm media type', () => {
    expect(parsePcmContentType('audio/mpeg')).toBeNull();
  });

  it('returns null when rate is missing', () => {
    expect(parsePcmContentType('audio/pcm;channels=1')).toBeNull();
  });

  it('returns null when channels is not 1', () => {
    expect(parsePcmContentType('audio/pcm;rate=24000;channels=2')).toBeNull();
  });

  it('returns null when channels is missing entirely (required, not defaulted)', () => {
    expect(parsePcmContentType('audio/pcm;rate=24000')).toBeNull();
  });

  it('returns null for a non-positive-integer rate', () => {
    expect(parsePcmContentType('audio/pcm;rate=0;channels=1')).toBeNull();
    expect(parsePcmContentType('audio/pcm;rate=-24000;channels=1')).toBeNull();
    expect(parsePcmContentType('audio/pcm;rate=24000.5;channels=1')).toBeNull();
    expect(parsePcmContentType('audio/pcm;rate=abc;channels=1')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parsePcmContentType(null)).toBeNull();
    expect(parsePcmContentType(undefined)).toBeNull();
  });
});

describe('PCM_ONLY_MODELS', () => {
  it('contains the Gemini TTS id', () => {
    expect(PCM_ONLY_MODELS.has('google/gemini-3.1-flash-tts-preview')).toBe(true);
  });
});

describe('speechRequestFormat', () => {
  it('pcm16 wanted + allow-listed model -> pcm16', () => {
    expect(speechRequestFormat('hexgrad/kokoro-82m', 'pcm16')).toBe('pcm16');
  });

  it('pcm16 wanted + PCM-only model (not in the static table) -> pcm16', () => {
    expect(speechRequestFormat('google/gemini-3.1-flash-tts-preview', 'pcm16')).toBe('pcm16');
  });

  it('pcm16 wanted + neither allow-listed nor PCM-only -> mp3', () => {
    expect(speechRequestFormat('minimax/speech-2.8-turbo', 'pcm16')).toBe('mp3');
  });

  it('mp3 wanted + PCM-only model -> pcm16 (upgrade)', () => {
    expect(speechRequestFormat('google/gemini-3.1-flash-tts-preview', 'mp3')).toBe('pcm16');
  });

  it('mp3 wanted + allow-listed (but not PCM-only) model -> mp3', () => {
    expect(speechRequestFormat('hexgrad/kokoro-82m', 'mp3')).toBe('mp3');
  });

  it('mp3 wanted + neither allow-listed nor PCM-only -> mp3', () => {
    expect(speechRequestFormat('minimax/speech-2.8-turbo', 'mp3')).toBe('mp3');
  });
});
