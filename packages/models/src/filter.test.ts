import { describe, expect, it } from 'vitest';
import { applySupportedFilter } from './filter.js';
import type { RawModel } from './types.js';

describe('applySupportedFilter', () => {
  it('returns only models matching SUPPORTED_MODELS patterns', () => {
    const raw: RawModel[] = [
      { provider: 'anthropic', id: 'claude-opus-4-5-20260301', label: 'Claude Opus 4.5' },
      { provider: 'anthropic', id: 'embedding-3-small', label: 'Embedding 3 Small' },
      { provider: 'openai', id: 'gpt-5.4', label: 'gpt-5.4' },
      { provider: 'openai', id: 'text-embedding-3-small', label: 'text-embedding-3-small' },
    ];
    const filtered = applySupportedFilter(raw);
    expect(filtered.map((m) => m.value)).toEqual([
      'anthropic/claude-opus-4-5-20260301',
      'openai/gpt-5.4',
    ]);
  });

  it('sorts by provider order, then by tier, then by id', () => {
    const raw: RawModel[] = [
      { provider: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { provider: 'anthropic', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      { provider: 'anthropic', id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
      { provider: 'anthropic', id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { provider: 'openai', id: 'gpt-4', label: 'GPT-4' },
      { provider: 'openai', id: 'o3-pro', label: 'o3-pro' },
    ];
    const filtered = applySupportedFilter(raw);
    expect(filtered.map((m) => m.value)).toEqual([
      // Anthropic block (tier 0, 1, 2)
      'anthropic/claude-opus-4-5',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-haiku-4-5',
      // OpenAI block (tier 0 = o3-pro, tier 25 = gpt-4)
      'openai/o3-pro',
      'openai/gpt-4',
      // Google block
      'google/gemini-2.5-flash',
    ]);
  });

  it('produces value as <provider>/<id>', () => {
    const raw: RawModel[] = [
      { provider: 'anthropic', id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
    ];
    const [m] = applySupportedFilter(raw);
    expect(m.value).toBe('anthropic/claude-opus-4-5');
    expect(m.label).toBe('Claude Opus 4.5');
    expect(m.provider).toBe('anthropic');
  });

  it('returns empty array for input with no allow-list matches', () => {
    const raw: RawModel[] = [
      { provider: 'anthropic', id: 'random-model', label: 'Random' },
      { provider: 'openai', id: 'whisper-1', label: 'Whisper' },
    ];
    expect(applySupportedFilter(raw)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(applySupportedFilter([])).toEqual([]);
  });

  it('drops Google non-chat modalities that match a broad allow pattern', () => {
    // gemini-2.5-flash-image / -preview-tts / -embedding all match a broad
    // gemini-* allow pattern but are excluded via EXCLUDED_MODELS; the plain
    // chat models must survive.
    const raw: RawModel[] = [
      { provider: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { provider: 'google', id: 'gemini-2.5-flash-image', label: 'Nano Banana' },
      { provider: 'google', id: 'gemini-2.5-pro-preview-tts', label: 'TTS' },
      { provider: 'google', id: 'gemini-embedding-001', label: 'Embedding' },
      { provider: 'google', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ];
    expect(applySupportedFilter(raw).map((m) => m.value)).toEqual([
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
    ]);
  });
});
