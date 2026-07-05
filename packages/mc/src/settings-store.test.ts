import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settings-store.js';

describe('SettingsStore', () => {
  let dir: string;
  let store: SettingsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'settings-test-'));
    store = new SettingsStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('returns empty object when file does not exist', async () => {
    const settings = await store.get();
    expect(settings).toEqual({});
  });

  it('persists and retrieves settings', async () => {
    await store.set({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });
    const settings = await store.get();
    expect(settings.defaultModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('merges patch into existing settings', async () => {
    await store.set({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });
    await store.set({ defaultFallbackModels: ['anthropic/claude-haiku-4-5-20251001'] });
    const settings = await store.get();
    expect(settings.defaultModel).toBe('anthropic/claude-sonnet-4-20250514');
    expect(settings.defaultFallbackModels).toEqual(['anthropic/claude-haiku-4-5-20251001']);
  });

  it('overwrites a key on set', async () => {
    await store.set({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });
    await store.set({ defaultModel: 'openai/gpt-4o' });
    const settings = await store.get();
    expect(settings.defaultModel).toBe('openai/gpt-4o');
  });

  it('round-trips setupCompletedAt without clobbering other fields', async () => {
    await store.set({ defaultModel: 'claude-opus-4-8' });
    await store.set({ setupCompletedAt: '2026-06-21T12:00:00.000Z' });
    const settings = await store.get();
    expect(settings.setupCompletedAt).toBe('2026-06-21T12:00:00.000Z');
    expect(settings.defaultModel).toBe('claude-opus-4-8');
  });

  it('round-trips companionWindowPos without clobbering other fields', async () => {
    await store.set({ defaultModel: 'claude-opus-4-8' });
    await store.set({ companionWindowPos: { x: 1720, y: 850 } });
    const settings = await store.get();
    expect(settings.companionWindowPos).toEqual({ x: 1720, y: 850 });
    expect(settings.defaultModel).toBe('claude-opus-4-8');
  });

  it('does not drop keys when two set calls overlap', async () => {
    // Fire both without awaiting between them: without write serialization the
    // second read-modify-write reads the same empty snapshot as the first and
    // clobbers its key. Both keys must survive.
    await Promise.all([
      store.set({ companionWindowPos: { x: 1, y: 2 } }),
      store.set({ defaultModel: 'm' }),
    ]);
    const settings = await store.get();
    expect(settings.companionWindowPos).toEqual({ x: 1, y: 2 });
    expect(settings.defaultModel).toBe('m');
  });
});
