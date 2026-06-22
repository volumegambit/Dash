import type { InstalledPlugin, PluginInstallResponse, PluginRecord } from '@dash/management';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { usePluginsStore } from './plugins.js';

function record(name: string, patch: Partial<PluginRecord> = {}): PluginRecord {
  return {
    name,
    status: 'loaded',
    enabled: true,
    trusted: true,
    activated: ['skills'],
    noop: [],
    ...patch,
  };
}

function installed(name: string, patch: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    name,
    version: '1.0.0',
    description: `${name} desc`,
    location: `/data/plugins/${name}`,
    scanVerdict: 'safe',
    scanReasons: [],
    source: `git:owner/${name}`,
    ...patch,
  };
}

beforeEach(() => {
  usePluginsStore.setState({ records: [], loading: false, error: null });
});

describe('usePluginsStore.loadPlugins', () => {
  it('populates records and clears loading/error', async () => {
    const records = [record('alpha'), record('beta')];
    mockApi.plugins.list.mockResolvedValueOnce(records);

    await usePluginsStore.getState().loadPlugins();

    const state = usePluginsStore.getState();
    expect(state.records).toEqual(records);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('sets error and clears loading on rejection', async () => {
    mockApi.plugins.list.mockRejectedValueOnce(new Error('boom'));

    await usePluginsStore.getState().loadPlugins();

    const state = usePluginsStore.getState();
    expect(state.error).toBe('boom');
    expect(state.loading).toBe(false);
    expect(state.records).toEqual([]);
  });
});

describe('usePluginsStore.setState', () => {
  it('replaces the matching record with the returned PluginRecord', async () => {
    usePluginsStore.setState({
      records: [record('alpha', { enabled: true }), record('beta')],
    });
    const updated = record('alpha', { enabled: false, status: 'disabled' });
    mockApi.plugins.setState.mockResolvedValueOnce(updated);

    await usePluginsStore.getState().setState('alpha', { enabled: false });

    expect(mockApi.plugins.setState).toHaveBeenCalledWith('alpha', { enabled: false });
    const state = usePluginsStore.getState();
    expect(state.records.find((r) => r.name === 'alpha')).toEqual(updated);
    // beta untouched
    expect(state.records.find((r) => r.name === 'beta')?.enabled).toBe(true);
    expect(state.error).toBeNull();
  });

  it('sets error and re-throws on failure without splicing', async () => {
    const before = [record('alpha', { enabled: true })];
    usePluginsStore.setState({ records: before });
    mockApi.plugins.setState.mockRejectedValueOnce(new Error('409 reload failed'));

    await expect(usePluginsStore.getState().setState('alpha', { trusted: false })).rejects.toThrow(
      '409 reload failed',
    );

    const state = usePluginsStore.getState();
    expect(state.error).toBe('409 reload failed');
    // record unchanged (not spliced)
    expect(state.records).toEqual(before);
  });
});

describe('usePluginsStore.install', () => {
  it('installs, refreshes the full records list, and returns a flat InstalledPlugin', async () => {
    const result: PluginInstallResponse = installed('gamma', { scanVerdict: 'suspicious' });
    mockApi.plugins.install.mockResolvedValueOnce(result);
    // loadPlugins() refresh returns the freshly-installed record
    const refreshed = [record('gamma')];
    mockApi.plugins.list.mockResolvedValueOnce(refreshed);

    const returned = await usePluginsStore.getState().install({ source: 'git:owner/gamma' });

    expect(mockApi.plugins.install).toHaveBeenCalledWith({ source: 'git:owner/gamma' });
    expect(mockApi.plugins.list).toHaveBeenCalledTimes(1);
    expect(returned).toBe(result);
    // records came from loadPlugins refresh, NOT from result.record
    expect(usePluginsStore.getState().records).toEqual(refreshed);
  });

  it('returns a reload-pending response and still refreshes records', async () => {
    const result: PluginInstallResponse = {
      ok: true,
      installed: installed('delta'),
      note: 'Plugin installed but reload failed; restart the gateway.',
      error: 'reload error',
    };
    mockApi.plugins.install.mockResolvedValueOnce(result);
    const refreshed = [record('delta', { status: 'disabled', enabled: false })];
    mockApi.plugins.list.mockResolvedValueOnce(refreshed);

    const returned = await usePluginsStore.getState().install({ source: 'git:owner/delta' });

    expect(returned).toBe(result);
    expect(mockApi.plugins.list).toHaveBeenCalledTimes(1);
    expect(usePluginsStore.getState().records).toEqual(refreshed);
  });

  it('sets error and re-throws on failure (no refresh)', async () => {
    mockApi.plugins.install.mockRejectedValueOnce(new Error('install failed'));

    await expect(usePluginsStore.getState().install({ source: 'git:owner/bad' })).rejects.toThrow(
      'install failed',
    );

    expect(mockApi.plugins.list).not.toHaveBeenCalled();
    expect(usePluginsStore.getState().error).toBe('install failed');
  });
});

describe('usePluginsStore.remove', () => {
  it('filters the removed record out', async () => {
    usePluginsStore.setState({ records: [record('alpha'), record('beta')] });
    mockApi.plugins.remove.mockResolvedValueOnce({ ok: true, path: '/data/plugins/alpha' });

    await usePluginsStore.getState().remove('alpha');

    expect(mockApi.plugins.remove).toHaveBeenCalledWith('alpha');
    const names = usePluginsStore.getState().records.map((r) => r.name);
    expect(names).toEqual(['beta']);
    expect(usePluginsStore.getState().error).toBeNull();
  });

  it('sets error and re-throws on failure but reconciles the list from the server', async () => {
    // A DELETE that throws (e.g. the gateway returns 409: the plugin was
    // removed on disk + config but the post-remove reload failed) must still
    // converge on server truth. remove() reloads in its catch block, so a
    // server-side-removed plugin disappears even though the error surfaces.
    const before = [record('alpha'), record('beta')];
    usePluginsStore.setState({ records: before });
    mockApi.plugins.remove.mockRejectedValueOnce(new Error('409 reload failed'));
    // Server truth after the failed remove: alpha is gone, beta remains.
    mockApi.plugins.list.mockResolvedValueOnce([record('beta')]);

    await expect(usePluginsStore.getState().remove('alpha')).rejects.toThrow('409 reload failed');

    const state = usePluginsStore.getState();
    // Error surfaced (the reload-failure message reaches the screen)...
    expect(state.error).toBe('409 reload failed');
    // ...but the list reconciled: the removed plugin is gone.
    expect(mockApi.plugins.list).toHaveBeenCalledTimes(1);
    expect(state.records.map((r) => r.name)).toEqual(['beta']);
  });
});

describe('usePluginsStore.reload', () => {
  it('triggers the api reload then a fresh loadPlugins', async () => {
    mockApi.plugins.reload.mockResolvedValueOnce({ ok: true, reloadedAt: '2026-06-22T00:00:00Z' });
    const refreshed = [record('alpha')];
    mockApi.plugins.list.mockResolvedValueOnce(refreshed);

    await usePluginsStore.getState().reload();

    expect(mockApi.plugins.reload).toHaveBeenCalledTimes(1);
    expect(mockApi.plugins.list).toHaveBeenCalledTimes(1);
    expect(usePluginsStore.getState().records).toEqual(refreshed);
  });

  it('sets error and re-throws on failure', async () => {
    mockApi.plugins.reload.mockRejectedValueOnce(new Error('reload failed'));

    await expect(usePluginsStore.getState().reload()).rejects.toThrow('reload failed');

    expect(mockApi.plugins.list).not.toHaveBeenCalled();
    expect(usePluginsStore.getState().error).toBe('reload failed');
  });
});
