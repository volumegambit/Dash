import { pcmFormatFor } from './pcm-formats.js';

describe('pcmFormatFor', () => {
  it('returns 24kHz mono 16-bit PCM for an openai/* model', () => {
    expect(pcmFormatFor('openai/gpt-4o-mini-tts-2025-12-15')).toEqual({
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
    });
  });

  it('returns null for a non-openai model', () => {
    expect(pcmFormatFor('mistralai/voxtral-mini-tts-2603')).toBeNull();
  });
});
