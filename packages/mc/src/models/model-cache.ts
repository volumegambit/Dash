import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

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
    const cache = await this.loadCache();
    return cache?.tools ?? [];
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
    const sorted = [...models].sort((a, b) => a.label.localeCompare(b.label));
    const existing = await this.loadCache();
    const cache: CacheFile = {
      fetchedAt: new Date().toISOString(),
      models: sorted,
      tools: tools ?? existing?.tools,
    };
    await writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2));
  }

  /**
   * Spawn a temporary OpenCode server, query all providers and their models,
   * save to cache, and shut down the server.
   * Returns the discovered models, or falls back to the existing cache on failure.
   */
  async refresh(): Promise<CachedModel[]> {
    if (this.refreshing) return this.load();
    this.refreshing = true;

    let serverClose: (() => void) | null = null;
    try {
      const { createOpencodeServer } = await import('@opencode-ai/sdk/v2');
      const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');

      // Isolate temp server's state from production deployments
      const ocTmpDir = join(this.dataDir, '.opencode-discovery');
      process.env.XDG_DATA_HOME = join(ocTmpDir, 'data');
      process.env.XDG_CONFIG_HOME = join(ocTmpDir, 'config');
      process.env.XDG_STATE_HOME = join(ocTmpDir, 'state');
      process.env.XDG_CACHE_HOME = join(ocTmpDir, 'cache');

      const port = await findFreePort();
      const server = await createOpencodeServer({ port });
      serverClose = () => server.close();

      const client = createOpencodeClient({ baseUrl: server.url });
      const response = await client.config.providers();
      if (response.error) throw new Error('Failed to fetch providers');

      const models: CachedModel[] = [];
      for (const provider of response.data?.providers ?? []) {
        for (const [modelId, model] of Object.entries(provider.models ?? {})) {
          // Skip deprecated models
          if (model.status === 'deprecated') continue;
          models.push({
            value: `${provider.id}/${modelId}`,
            label: model.name || modelId,
            provider: provider.id,
          });
        }
      }

      // Fetch available tool IDs
      let tools: string[] | undefined;
      try {
        const toolResponse = await client.tool.ids();
        if (!toolResponse.error && toolResponse.data) {
          tools = toolResponse.data.sort();
        }
      } catch {
        // Tool query failed — keep existing cached tools
      }

      await this.save(models, tools);
      return models;
    } catch {
      // Refresh failed — return existing cache if available
      return this.load();
    } finally {
      serverClose?.();
      this.refreshing = false;
    }
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}
