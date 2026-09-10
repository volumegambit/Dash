import { PCM16_MODELS, pcmFormatFor } from './pcm-formats.js';

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
