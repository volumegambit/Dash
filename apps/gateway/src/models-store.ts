import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FilteredModel } from '@dash/plugin-sdk';

/**
 * Persistent on-disk shape of the gateway's model store. Lives next to
 * `channels.json`, `agents.json`, and `gateway-state.json` in the gateway
 * data directory.
 *
 * `supportedModelsReviewedAt` is a stale-detection key. The fingerprint is now
 * supplied by the caller from LIVE catalog data (the newest `reviewedAt` across
 * the loaded provider catalogs) rather than a source constant: when a catalog
 * audit bumps a `reviewedAt` (patterns changed), the persisted file no longer
 * matches the current fingerprint and `load()` treats it as missing, forcing a
 * clean refetch. The field name is kept for on-disk compatibility — an existing
 * `models.json` written under `@dash/models`' `MODELS_REVIEWED_AT` simply
 * mismatches the new catalog fingerprint and refetches once.
 */
export interface ModelsStoreFile {
  fetchedAt: string;
  supportedModelsReviewedAt: string;
  models: FilteredModel[];
}

/**
 * Persistent gateway model store. Atomic writes via tmp+rename. Stale
 * invalidation against a caller-supplied fingerprint (the newest catalog
 * `reviewedAt`), so the store never serves data curated under a different
 * catalog revision.
 */
export class ModelsStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'models.json');
  }

  /**
   * Load the store from disk. Returns null when:
   *   - the file doesn't exist
   *   - the file is corrupt JSON
   *   - the persisted `supportedModelsReviewedAt` doesn't match
   *     `currentReviewedAt` (the catalogs have been re-reviewed since this
   *     file was written)
   *
   * Callers treat null as "no usable data, refetch live or return the
   * catalogs' static models depending on credential state".
   */
  async load(currentReviewedAt: string): Promise<ModelsStoreFile | null> {
    if (!existsSync(this.filePath)) return null;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch {
      return null;
    }
    let parsed: ModelsStoreFile;
    try {
      parsed = JSON.parse(raw) as ModelsStoreFile;
    } catch {
      // Corrupt JSON. Don't crash; treat as missing so the next refresh
      // overwrites it cleanly.
      return null;
    }
    if (parsed.supportedModelsReviewedAt !== currentReviewedAt) {
      // Catalogs have been re-reviewed since this file was written. Force a
      // refresh so curation stays in sync.
      return null;
    }
    return parsed;
  }

  /**
   * Persist a fresh model list to disk with the fingerprint it was curated
   * under. Atomic write via tmp+rename (matches the pattern used by
   * AgentRegistry, ChannelRegistry, GatewayStateStore).
   */
  async save(models: FilteredModel[], reviewedAt: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: ModelsStoreFile = {
      fetchedAt: new Date().toISOString(),
      supportedModelsReviewedAt: reviewedAt,
      models,
    };
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2));
    await rename(tmpPath, this.filePath);
  }

  /**
   * Delete the persisted store. Used by credential-change handlers to
   * force the next `GET /models` to refetch (a credential add or remove
   * may change which providers are queryable).
   */
  async clear(): Promise<void> {
    if (existsSync(this.filePath)) {
      await unlink(this.filePath).catch(() => {});
    }
  }
}
