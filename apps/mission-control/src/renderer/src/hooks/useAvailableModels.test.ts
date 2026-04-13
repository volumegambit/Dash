import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { useAvailableModels } from './useAvailableModels.js';

/**
 * The hook is now a thin wrapper over the gateway's GET /models endpoint.
 * It does not filter by credentials anymore — the gateway already returns
 * only providers with credentials (or BOOTSTRAP_MODELS when zero
 * credentials are configured). MC just renders whatever it gets.
 */
describe('useAvailableModels', () => {
  beforeEach(() => {
    mockApi.credentialsList.mockResolvedValue([]);
    mockApi.modelsList.mockResolvedValue({
      models: [],
      source: 'bootstrap',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
    mockApi.modelsRefresh.mockResolvedValue({
      models: [],
      source: 'bootstrap',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
  });

  it('returns an empty list when the gateway returns no models', async () => {
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      expect(result.current.models).toHaveLength(0);
    });
  });

  it('renders whatever the gateway returns, without applying its own filter', async () => {
    mockApi.modelsList.mockResolvedValue({
      models: [
        { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
        { value: 'openai/gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
      ],
      source: 'live',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      expect(result.current.models.map((m) => m.value)).toEqual([
        'anthropic/claude-opus-4-5',
        'openai/gpt-5.4',
      ]);
    });
  });

  it('refresh callback calls modelsRefresh and updates state', async () => {
    mockApi.modelsList.mockResolvedValue({
      models: [],
      source: 'bootstrap',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
    mockApi.modelsRefresh.mockResolvedValue({
      models: [
        { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
      ],
      source: 'live',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      expect(result.current.models).toHaveLength(0);
    });
    result.current.refresh();
    await waitFor(() => {
      expect(result.current.models).toHaveLength(1);
    });
  });

  it('exposes refresh function and refreshing state', async () => {
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => {
      expect(typeof result.current.refresh).toBe('function');
      expect(result.current.refreshing).toBe(false);
    });
  });
});
