import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { useRuntimeProviders } from './useRuntimeProviders.js';

/**
 * The hook is a thin wrapper over the T1 IPC bridge
 * `window.api.plugins.runtime()` (returns RuntimePluginsResponse). On
 * failure it degrades gracefully — a gateway/plugins error must not break
 * the AI Providers page — so providers/plugins stay empty and `error` is set.
 */
describe('useRuntimeProviders', () => {
  beforeEach(() => {
    mockApi.plugins.runtime.mockResolvedValue({ providers: [], plugins: [] });
  });

  it('populates providers and plugins on success, with loading false', async () => {
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [{ id: 'acme', label: 'Acme AI', credentialPrefix: 'ACME' }],
      plugins: [{ name: 'acme-plugin', displayName: 'Acme', version: '1.0.0' }],
    });
    const { result } = renderHook(() => useRuntimeProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.providers).toEqual([
      { id: 'acme', label: 'Acme AI', credentialPrefix: 'ACME' },
    ]);
    expect(result.current.plugins).toEqual([
      { name: 'acme-plugin', displayName: 'Acme', version: '1.0.0' },
    ]);
    expect(result.current.error).toBeNull();
  });

  it('degrades gracefully on rejection: error set, providers/plugins empty, loading false', async () => {
    mockApi.plugins.runtime.mockRejectedValue(new Error('gateway down'));
    const { result } = renderHook(() => useRuntimeProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('gateway down');
    expect(result.current.providers).toEqual([]);
    expect(result.current.plugins).toEqual([]);
  });

  it('refetch re-calls window.api.plugins.runtime and updates state', async () => {
    mockApi.plugins.runtime.mockResolvedValue({ providers: [], plugins: [] });
    const { result } = renderHook(() => useRuntimeProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.providers).toEqual([]);
    expect(mockApi.plugins.runtime).toHaveBeenCalledTimes(1);

    mockApi.plugins.runtime.mockResolvedValue({
      providers: [{ id: 'beta', label: 'Beta', credentialPrefix: 'BETA' }],
      plugins: [],
    });
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.providers).toHaveLength(1);
    });
    expect(result.current.providers[0]?.id).toBe('beta');
    expect(mockApi.plugins.runtime).toHaveBeenCalledTimes(2);
  });

  it('clears a prior error on a successful refetch', async () => {
    mockApi.plugins.runtime.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useRuntimeProviders());

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });

    mockApi.plugins.runtime.mockResolvedValue({
      providers: [{ id: 'gamma', label: 'Gamma', credentialPrefix: 'GAMMA' }],
      plugins: [],
    });
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
    expect(result.current.providers).toHaveLength(1);
  });
});
