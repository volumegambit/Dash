import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CachedModel {
  value: string; // "provider/model-id"
  label: string; // human-readable name
  provider: string; // "anthropic", "openai", "google", etc.
}

interface CacheFile {
  fetchedAt: string;
  models: CachedModel[];
}

export class ModelCacheService {
  private cacheFilePath: string;
  private refreshing = false;

  constructor(dataDir: string) {
    this.cacheFilePath = join(dataDir, 'models-cache.json');
  }

  async load(): Promise<CachedModel[]> {
    if (!existsSync(this.cacheFilePath)) return [];
    try {
      const raw = await readFile(this.cacheFilePath, 'utf-8');
      const cache = JSON.parse(raw) as CacheFile;
      return cache.models ?? [];
    } catch {
      await unlink(this.cacheFilePath).catch(() => {});
      return [];
    }
  }

  async save(models: CachedModel[]): Promise<void> {
    const sorted = [...models].sort((a, b) => a.label.localeCompare(b.label));
    const cache: CacheFile = {
      fetchedAt: new Date().toISOString(),
      models: sorted,
    };
    await writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2));
  }

  /**
   * Query PiAgent's in-process model registry for all available models,
   * save to cache, and return the list.
   * Falls back to the existing cache on failure.
   */
  async refresh(): Promise<CachedModel[]> {
    if (this.refreshing) return this.load();
    this.refreshing = true;

    try {
      const { getProviders, getModels } = await import('@mariozechner/pi-ai');
      const providers = getProviders();
      const models: CachedModel[] = [];

      for (const providerId of providers) {
        for (const model of getModels(providerId)) {
          models.push({
            value: `${model.provider}/${model.id}`,
            label: model.name || model.id,
            provider: model.provider,
          });
        }
      }

      await this.save(models);
      return models;
    } catch {
      return this.load();
    } finally {
      this.refreshing = false;
    }
  }
}
