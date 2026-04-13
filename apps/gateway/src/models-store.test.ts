import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS_REVIEWED_AT } from '@dash/models';
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
    expect(await store.load()).toBeNull();
  });

  it('save then load round-trips the data', async () => {
    const models = [
      { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic' },
    ];
    await store.save(models);
    const loaded = await store.load();
    expect(loaded?.models).toEqual(models);
    expect(loaded?.supportedModelsReviewedAt).toBe(MODELS_REVIEWED_AT);
    expect(loaded?.fetchedAt).toBeDefined();
  });

  it('atomic write: file content is fully formed (no half-written file)', async () => {
    const models = [{ value: 'openai/gpt-5.4', label: 'GPT-5.4', provider: 'openai' }];
    await store.save(models);
    const raw = await readFile(join(dataDir, 'models.json'), 'utf-8');
    // Either fully parseable or absent — never partial.
    const parsed = JSON.parse(raw);
    expect(parsed.models).toEqual(models);
  });

  it('load returns null when supportedModelsReviewedAt mismatches', async () => {
    // Hand-write a store file with a stale stale-detection key.
    await writeFile(
      join(dataDir, 'models.json'),
      JSON.stringify({
        fetchedAt: '2025-01-01T00:00:00Z',
        supportedModelsReviewedAt: '2020-01-01', // stale
        models: [{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }],
      }),
    );
    expect(await store.load()).toBeNull();
  });

  it('load returns null on corrupt JSON', async () => {
    await writeFile(join(dataDir, 'models.json'), '{not json');
    expect(await store.load()).toBeNull();
  });

  it('clear deletes the file', async () => {
    await store.save([{ value: 'anthropic/claude-opus-4-5', label: 'X', provider: 'anthropic' }]);
    expect(await store.load()).not.toBeNull();
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('clear is a no-op when the file does not exist', async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
