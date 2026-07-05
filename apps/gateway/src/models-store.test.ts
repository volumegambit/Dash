import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelsStore } from './models-store.js';

describe('ModelsStore', () => {
  let dataDir: string;
  let store: ModelsStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'models-store-'));
    store = new ModelsStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('load returns null when the file does not exist', async () => {
    expect(await store.load('2026-07-01')).toBeNull();
  });

  it('save then load round-trips the data at the same fingerprint', async () => {
    const models = [
      { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
    ];
    await store.save(models, '2026-07-01');
    const loaded = await store.load('2026-07-01');
    expect(loaded?.models).toEqual(models);
    expect(loaded?.supportedModelsReviewedAt).toBe('2026-07-01');
    expect(loaded?.fetchedAt).toBeDefined();
  });

  it('atomic write: file content is fully formed (no half-written file)', async () => {
    const models = [{ value: 'openai/gpt-5.4', label: 'GPT-5.4', provider: 'openai' }];
    await store.save(models, '2026-07-01');
    const raw = await readFile(join(dataDir, 'models.json'), 'utf-8');
    // Either fully parseable or absent — never partial.
    const parsed = JSON.parse(raw);
    expect(parsed.models).toEqual(models);
  });

  it('load returns null when the fingerprint has moved', async () => {
    const models = [
      { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
    ];
    await store.save(models, '2026-07-01');
    // A newer catalog reviewedAt invalidates the stored file.
    expect(await store.load('2026-07-02')).toBeNull();
  });

  it('load returns null on corrupt JSON', async () => {
    await writeFile(join(dataDir, 'models.json'), '{not json');
    expect(await store.load('2026-07-01')).toBeNull();
  });

  it('clear deletes the file', async () => {
    await store.save(
      [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
      '2026-07-01',
    );
    expect(await store.load('2026-07-01')).not.toBeNull();
    await store.clear();
    expect(await store.load('2026-07-01')).toBeNull();
  });

  it('clear is a no-op when the file does not exist', async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
