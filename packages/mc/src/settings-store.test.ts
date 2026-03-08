import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
