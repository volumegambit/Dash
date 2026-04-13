import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type FilteredModel, MODELS_REVIEWED_AT } from '@dash/models';

/**
 * Persistent on-disk shape of the gateway's model store. Lives next to
 * `channels.json`, `agents.json`, and `gateway-state.json` in the gateway
 * data directory.
 *
 * `supportedModelsReviewedAt` is a stale-detection key: if the gateway is
 * upgraded with a new `MODELS_REVIEWED_AT` (e.g. the audit script bumped
 * patterns), the old store is automatically treated as missing on the
 * next read. This forces a fresh fetch whenever curation changes, so the
 * store never goes out of sync with the allow-list.
 */
export interface ModelsStoreFile {
  fetchedAt: string;
  supportedModelsReviewedAt: string;
  models: FilteredModel[];
}

/**
 * Persistent gateway model store. Atomic writes via tmp+rename. Auto
 * stale-invalidation against the in-source `MODELS_REVIEWED_AT`.
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
   *   - the persisted `supportedModelsReviewedAt` doesn't match the
   *     current source `MODELS_REVIEWED_AT` (allow-list has changed
   *     since this file was written)
   *
   * Callers treat null as "no usable data, refetch live or return
   * BOOTSTRAP_MODELS depending on credential state".
   */
  async load(): Promise<ModelsStoreFile | null> {
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
    if (parsed.supportedModelsReviewedAt !== MODELS_REVIEWED_AT) {
      // Allow-list has changed since this file was written. Force a
      // refresh so curation stays in sync.
      return null;
    }
    return parsed;
  }

  /**
   * Persist a fresh model list to disk. Atomic write via tmp+rename
   * (matches the pattern used by AgentRegistry, ChannelRegistry,
   * GatewayStateStore).
   */
  async save(models: FilteredModel[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: ModelsStoreFile = {
      fetchedAt: new Date().toISOString(),
      supportedModelsReviewedAt: MODELS_REVIEWED_AT,
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
