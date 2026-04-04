import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { useAvailableModels } from './useAvailableModels.js';

describe('useAvailableModels', () => {
  beforeEach(() => {
    mockApi.credentialsList.mockResolvedValue([]);
    mockApi.modelsList.mockResolvedValue([]);
  });

  it('returns no models when no keys are present', async () => {
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      expect(result.current.models).toHaveLength(0);
    });
  });

  it('returns only anthropic models when only anthropic key is present', async () => {
    mockApi.credentialsList.mockResolvedValue(['anthropic-api-key:default']);
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      expect(result.current.models.every((m) => m.provider === 'anthropic')).toBe(true);
      expect(result.current.models.length).toBeGreaterThan(0);
    });
  });

  it('returns models from all providers when all keys are present', async () => {
    mockApi.credentialsList.mockResolvedValue([
      'anthropic-api-key:default',
      'openai-api-key:default',
      'google-api-key:default',
    ]);
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      const providers = new Set(result.current.models.map((m) => m.provider));
      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
      expect(providers).toContain('google');
    });
  });

  it('exposes refresh function and refreshing state', async () => {
    mockApi.credentialsList.mockResolvedValue(['anthropic-api-key:default']);
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      expect(typeof result.current.refresh).toBe('function');
      expect(result.current.refreshing).toBe(false);
    });
  });
});
