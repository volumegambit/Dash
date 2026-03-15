import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelCacheService } from './model-cache.js';

describe('ModelCacheService', () => {
  let tmpDir: string;
  let service: ModelCacheService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'model-cache-test-'));
    service = new ModelCacheService(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('load() returns empty array when no cache file exists', async () => {
    const models = await service.load();
    expect(models).toEqual([]);
  });

  it('load() returns cached models from file', async () => {
    const models = [
      { value: 'anthropic/claude-opus-4', label: 'Claude Opus 4', provider: 'anthropic' },
      { value: 'openai/gpt-4o', label: 'GPT-4o', provider: 'openai' },
    ];
    await service.save(models);
    const loaded = await service.load();
    expect(loaded).toEqual(models);
  });

  it('load() returns empty array on corrupt cache file', async () => {
    await writeFile(join(tmpDir, 'models-cache.json'), 'not json');
    const models = await service.load();
    expect(models).toEqual([]);
    // Corrupt file should be deleted
    expect(existsSync(join(tmpDir, 'models-cache.json'))).toBe(false);
  });

  it('save() writes cache with fetchedAt timestamp', async () => {
    const models = [
      { value: 'anthropic/claude-opus-4', label: 'Claude Opus 4', provider: 'anthropic' },
    ];
    await service.save(models);

    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(tmpDir, 'models-cache.json'), 'utf-8'),
    );
    const cache = JSON.parse(raw) as { fetchedAt: string; models: unknown[] };
    expect(cache.fetchedAt).toBeTruthy();
    expect(cache.models).toEqual(models);
  });
});
