import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from './registry.js';
import type { LlmProvider, CompletionRequest, CompletionResponse, StreamChunk } from './types.js';

function mockProvider(name: string): LlmProvider {
  return {
    name,
    complete: async () => ({} as CompletionResponse),
    async *stream() {
      return {} as CompletionResponse;
    },
  };
}

describe('ProviderRegistry', () => {
  it('registers and retrieves providers', () => {
    const registry = new ProviderRegistry();
    const provider = mockProvider('test');
    registry.register(provider);

    expect(registry.get('test')).toBe(provider);
    expect(registry.has('test')).toBe(true);
    expect(registry.list()).toEqual(['test']);
  });

  it('throws on unknown provider', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('nope')).toThrow('LLM provider "nope" not registered');
  });

  it('resolves provider by model prefix', () => {
    const registry = new ProviderRegistry();
    const anthropic = mockProvider('anthropic');
    registry.register(anthropic);

    expect(registry.resolveProvider('claude-sonnet-4-20250514')).toBe(anthropic);
  });

  it('falls back to first provider for unknown model prefix', () => {
    const registry = new ProviderRegistry();
    const p = mockProvider('custom');
    registry.register(p);

    expect(registry.resolveProvider('llama-3')).toBe(p);
  });
});
