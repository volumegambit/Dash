import type { LlmProvider } from './types.js';

export class ProviderRegistry {
  private providers = new Map<string, LlmProvider>();

  register(provider: LlmProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): LlmProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`LLM provider "${name}" not registered. Available: ${this.list().join(', ')}`);
    }
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  resolveProvider(model: string): LlmProvider {
    if (model.startsWith('claude-')) return this.get('anthropic');
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
      return this.get('openai');
    if (model.startsWith('gemini-')) return this.get('google');

    // Fall back to first registered provider
    const first = this.providers.values().next().value;
    if (!first) throw new Error('No LLM providers registered');
    return first;
  }
}
