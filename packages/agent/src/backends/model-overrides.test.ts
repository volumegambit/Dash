import { getModel } from '@mariozechner/pi-ai';

import { getModelOverride } from './model-overrides.js';

describe('model-overrides', () => {
  it('supplies a runnable Model for anthropic/claude-opus-4-8', () => {
    const model = getModelOverride('anthropic', 'claude-opus-4-8');
    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: 'claude-opus-4-8',
      provider: 'anthropic',
      api: 'anthropic-messages',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(model?.input).toEqual(['text', 'image']);
    expect(model?.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it('supplies a runnable Model for anthropic/claude-fable-5', () => {
    const model = getModelOverride('anthropic', 'claude-fable-5');
    expect(model).toBeDefined();
    expect(model).toMatchObject({
      id: 'claude-fable-5',
      provider: 'anthropic',
      api: 'anthropic-messages',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(model?.input).toEqual(['text', 'image']);
    expect(model?.cost).toEqual({ input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 });
  });

  // reasoning:false is load-bearing — pi-ai's anthropic provider gates the
  // thinking param on model.reasoning, and pi-ai's supportsAdaptiveThinking()
  // doesn't recognize these ids, so any thinking param it would emit (legacy
  // budget_tokens, or {type:"disabled"} for Fable) gets a 400. Omitting the
  // param is the only shape both models accept. See model-overrides.ts header.
  it('disables pi-ai thinking-param emission for overridden models', () => {
    expect(getModelOverride('anthropic', 'claude-opus-4-8')?.reasoning).toBe(false);
    expect(getModelOverride('anthropic', 'claude-fable-5')?.reasoning).toBe(false);
  });

  it('returns undefined for models with no override', () => {
    expect(getModelOverride('anthropic', 'claude-sonnet-4-6')).toBeUndefined();
    expect(getModelOverride('openai', 'gpt-5.4')).toBeUndefined();
    expect(getModelOverride('anthropic', 'made-up-model')).toBeUndefined();
  });

  // Root-cause tripwire: these overrides only exist because the pinned pi-ai
  // build has no entry for these ids. When a future pi-ai upgrade adds one,
  // its assertion flips and we can delete that override. Verified against the
  // pinned and latest (0.73.1) pi-ai builds on 2026-06-20.
  it('only overrides models the pinned pi-ai registry is missing', () => {
    // biome-ignore lint/suspicious/noExplicitAny: getModel generics require statically-known ids
    expect(getModel('anthropic' as any, 'claude-opus-4-8' as any)).toBeUndefined();
    // biome-ignore lint/suspicious/noExplicitAny: getModel generics require statically-known ids
    expect(getModel('anthropic' as any, 'claude-fable-5' as any)).toBeUndefined();
    // pi-ai DOES know 4.7, so we must NOT shadow it with an override.
    // biome-ignore lint/suspicious/noExplicitAny: getModel generics require statically-known ids
    expect(getModel('anthropic' as any, 'claude-opus-4-7' as any)).toBeDefined();
    expect(getModelOverride('anthropic', 'claude-opus-4-7')).toBeUndefined();
  });
});
