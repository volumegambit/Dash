import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_TOOL_NAMES } from '@dash/agent';
import { findSupportedModel } from './supported-models.js';

export interface CachedModel {
  value: string; // "provider/model-id"
  label: string; // human-readable name
  provider: string; // "anthropic", "openai", "google", etc.
}

interface CacheFile {
  fetchedAt: string;
  models: CachedModel[];
  tools?: string[];
}

export class ModelCacheService {
  private cacheFilePath: string;
  private dataDir: string;
  private refreshing = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.cacheFilePath = join(dataDir, 'models-cache.json');
  }

  async load(): Promise<CachedModel[]> {
    const cache = await this.loadCache();
    return cache?.models ?? [];
  }

  async loadTools(): Promise<string[]> {
    return [...AGENT_TOOL_NAMES];
  }

  private async loadCache(): Promise<CacheFile | null> {
    if (!existsSync(this.cacheFilePath)) return null;
    try {
      const raw = await readFile(this.cacheFilePath, 'utf-8');
      return JSON.parse(raw) as CacheFile;
    } catch {
      await unlink(this.cacheFilePath).catch(() => {});
      return null;
    }
  }

  async save(models: CachedModel[], tools?: string[]): Promise<void> {
    const providerOrder = ['anthropic', 'openai', 'google'];
    const sorted = [...models].sort((a, b) => {
      const pa = providerOrder.indexOf(a.provider);
      const pb = providerOrder.indexOf(b.provider);
      const providerDiff = (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      if (providerDiff !== 0) return providerDiff;
      const modelIdA = a.value.includes('/') ? a.value.split('/')[1] : a.value;
      const modelIdB = b.value.includes('/') ? b.value.split('/')[1] : b.value;
      const tierA = findSupportedModel(a.provider, modelIdA)?.tier ?? 99;
      const tierB = findSupportedModel(b.provider, modelIdB)?.tier ?? 99;
      return tierA - tierB;
    });
    const existing = await this.loadCache();
    const cache: CacheFile = {
      fetchedAt: new Date().toISOString(),
      models: sorted,
      tools: tools ?? existing?.tools,
    };
    await writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2));
  }

}
