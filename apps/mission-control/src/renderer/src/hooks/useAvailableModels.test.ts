import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSecretsStore } from '../stores/secrets.js';
import { useAvailableModels } from './useAvailableModels.js';

describe('useAvailableModels', () => {
  beforeEach(() => {
    useSecretsStore.setState({ keys: [] });
  });

  it('returns no models when no keys are present', () => {
    const { result } = renderHook(() => useAvailableModels());
    expect(result.current).toHaveLength(0);
  });

  it('returns only anthropic models when only anthropic key is present', () => {
    useSecretsStore.setState({ keys: ['anthropic-api-key'] });
    const { result } = renderHook(() => useAvailableModels());
    expect(result.current.every((m) => m.provider === 'anthropic')).toBe(true);
    expect(result.current.length).toBeGreaterThan(0);
  });

  it('returns models from all providers when all keys are present', () => {
    useSecretsStore.setState({
      keys: ['anthropic-api-key', 'openai-api-key', 'google-api-key'],
    });
    const { result } = renderHook(() => useAvailableModels());
    const providers = new Set(result.current.map((m) => m.provider));
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toContain('google');
  });
});
