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
    expect(result.current.models).toHaveLength(0);
  });

  it('returns only anthropic models when only anthropic key is present', () => {
    useSecretsStore.setState({ keys: ['anthropic-api-key:default'] });
    const { result } = renderHook(() => useAvailableModels());
    expect(result.current.models.every((m) => m.provider === 'anthropic')).toBe(true);
    expect(result.current.models.length).toBeGreaterThan(0);
  });

  it('returns models from all providers when all keys are present', () => {
    useSecretsStore.setState({
      keys: ['anthropic-api-key:default', 'openai-api-key:default', 'google-api-key:default'],
    });
    const { result } = renderHook(() => useAvailableModels());
    const providers = new Set(result.current.models.map((m) => m.provider));
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toContain('google');
  });

  it('exposes refresh function and refreshing state', () => {
    useSecretsStore.setState({ keys: ['anthropic-api-key:default'] });
    const { result } = renderHook(() => useAvailableModels());
    expect(typeof result.current.refresh).toBe('function');
    expect(result.current.refreshing).toBe(false);
  });
});
