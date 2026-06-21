import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayCredentialStore } from './credential-store.js';
import { OAuthRefreshCoordinator } from './oauth-refresh.js';

let dataDir: string;
let store: GatewayCredentialStore;

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gateway-oauth-refresh-'));
  store = new GatewayCredentialStore(dataDir);
  await store.init();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('OAuthRefreshCoordinator', () => {
  it('refreshes and persists a credential within the expiry margin', async () => {
    await store.set('anthropic-api-key:default', 'sk-ant-oat01-old');
    await store.set('anthropic-oauth-refresh:default', 'refresh-old');
    // Expires in 1 minute — inside the default 30-minute margin.
    await store.set('anthropic-oauth-expires:default', String(NOW + 60_000));

    const refresher = vi.fn(async (_token: string) => ({
      access: 'sk-ant-oat01-new',
      refresh: 'refresh-new',
      expires: NOW + 8 * HOUR,
    }));

    const coord = new OAuthRefreshCoordinator(store, {
      now: () => NOW,
      refreshers: { anthropic: refresher },
    });

    await coord.refreshExpiring();

    expect(refresher).toHaveBeenCalledWith('refresh-old');
    expect(await store.get('anthropic-api-key:default')).toBe('sk-ant-oat01-new');
    expect(await store.get('anthropic-oauth-refresh:default')).toBe('refresh-new');
    expect(await store.get('anthropic-oauth-expires:default')).toBe(String(NOW + 8 * HOUR));
  });

  it('leaves credentials untouched and does not throw when refresh fails', async () => {
    await store.set('anthropic-api-key:default', 'sk-ant-oat01-old');
    await store.set('anthropic-oauth-refresh:default', 'refresh-old');
    await store.set('anthropic-oauth-expires:default', String(NOW - 1000)); // already expired

    const refresher = vi.fn(async (_token: string): Promise<never> => {
      throw new Error('refresh token revoked');
    });

    const coord = new OAuthRefreshCoordinator(store, {
      now: () => NOW,
      refreshers: { anthropic: refresher },
      logger: { error: () => {} },
    });

    await expect(coord.refreshExpiring()).resolves.toBeUndefined();

    // Stale creds preserved so the agent's next call surfaces a 401 → re-auth.
    expect(await store.get('anthropic-api-key:default')).toBe('sk-ant-oat01-old');
    expect(await store.get('anthropic-oauth-refresh:default')).toBe('refresh-old');
    expect(await store.get('anthropic-oauth-expires:default')).toBe(String(NOW - 1000));
  });

  it('coalesces concurrent refreshes of the same credential (single-flight)', async () => {
    await store.set('anthropic-api-key:default', 'sk-ant-oat01-old');
    await store.set('anthropic-oauth-refresh:default', 'refresh-old');
    await store.set('anthropic-oauth-expires:default', String(NOW - 1000)); // expired

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresher = vi.fn(async (_token: string) => {
      await gate; // hold the first refresh open so the second call overlaps it
      return { access: 'sk-ant-oat01-new', refresh: 'refresh-new', expires: NOW + 8 * HOUR };
    });

    const coord = new OAuthRefreshCoordinator(store, {
      now: () => NOW,
      refreshers: { anthropic: refresher },
    });

    const first = coord.refreshExpiring();
    const second = coord.refreshExpiring();
    release();
    await Promise.all([first, second]);

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(await store.get('anthropic-oauth-refresh:default')).toBe('refresh-new');
  });

  it('only refreshes credentials within the margin, leaving fresh ones untouched', async () => {
    // anthropic: near expiry → should refresh
    await store.set('anthropic-api-key:default', 'sk-ant-oat01-old');
    await store.set('anthropic-oauth-refresh:default', 'a-refresh-old');
    await store.set('anthropic-oauth-expires:default', String(NOW + 60_000));
    // openai: hours of life left → should be left alone
    await store.set('openai-api-key:default', 'jwt-old');
    await store.set('openai-oauth-refresh:default', 'o-refresh-old');
    await store.set('openai-oauth-expires:default', String(NOW + 6 * HOUR));

    const anthropic = vi.fn(async (_t: string) => ({
      access: 'sk-ant-oat01-new',
      refresh: 'a-refresh-new',
      expires: NOW + 8 * HOUR,
    }));
    const openai = vi.fn(async (_t: string) => ({
      access: 'jwt-new',
      refresh: 'o-refresh-new',
      expires: NOW + 8 * HOUR,
    }));

    const coord = new OAuthRefreshCoordinator(store, {
      now: () => NOW,
      refreshers: { anthropic, openai },
    });

    await coord.refreshExpiring();

    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(openai).not.toHaveBeenCalled();
    expect(await store.get('anthropic-api-key:default')).toBe('sk-ant-oat01-new');
    expect(await store.get('openai-api-key:default')).toBe('jwt-old');
  });

  it('skips a provider that has no configured refresher', async () => {
    await store.set('github-api-key:default', 'gh-old');
    await store.set('github-oauth-refresh:default', 'gh-refresh-old');
    await store.set('github-oauth-expires:default', String(NOW - 1000)); // expired

    const coord = new OAuthRefreshCoordinator(store, {
      now: () => NOW,
      refreshers: {}, // none for github
      logger: { warn: () => {} },
    });

    await coord.refreshExpiring();

    expect(await store.get('github-api-key:default')).toBe('gh-old');
    expect(await store.get('github-oauth-refresh:default')).toBe('gh-refresh-old');
  });
});
