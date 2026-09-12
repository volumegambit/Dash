import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_SPEECH_CONFIG,
  type SpeechConfig,
  type SpeechConfigPatch,
  mergeSpeechConfig,
} from '@dash/speech';

/**
 * Persistent gateway speech config store. Lives next to `models.json`,
 * `channels.json`, and `agents.json` in the gateway data directory as
 * `speech.json`.
 *
 * `load()` never throws for a missing or corrupt file — both fall back to
 * `DEFAULT_SPEECH_CONFIG` so a broken store never takes down the gateway. A
 * corrupt file is quarantined (renamed aside) rather than silently
 * discarded, so the bad content is still on disk for inspection. `save()`
 * DOES propagate write errors to the caller (repo rule: storage errors
 * propagate) — only `load()` swallows failures.
 *
 * A persisted file is merged field-by-field over `DEFAULT_SPEECH_CONFIG`:
 * only recognized keys are copied across, so a file written before a new
 * key existed (e.g. `realtime`, or `tts.speed`) still loads with that key
 * defaulted, and an unrecognized/legacy key on disk is dropped rather than
 * spread into the result.
 */
export class SpeechConfigStore {
  private filePath: string;
  /**
   * Single in-process write queue. `save()` calls chain onto this promise so
   * two overlapping writes cannot race on the temp file. The queue never
   * rejects — a failed write propagates to its awaiting caller while the
   * chain stays resolved so it does not wedge later writes. Mirrors
   * `ModelsStore` / `AgentRegistry` / `PluginConfigStore`.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'speech.json');
  }

  /**
   * Serialize a write against the on-disk store behind the write queue.
   * Returns a promise that settles with `fn`'s outcome; the chain absorbs
   * the rejection so a failed write never blocks subsequent ones.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Load the store from disk, merged over `DEFAULT_SPEECH_CONFIG`. Returns
   * the defaults when:
   *   - the file doesn't exist
   *   - the file can't be read
   *   - the file is corrupt JSON (the file is quarantined first — renamed to
   *     `speech.json.corrupt-<ISO timestamp with colons replaced by dashes>`
   *     so the bad content survives for inspection and the next `save()`
   *     starts clean)
   *
   * Never throws.
   */
  async load(): Promise<SpeechConfig> {
    if (!existsSync(this.filePath)) {
      return cloneDefaultConfig();
    }
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch {
      return cloneDefaultConfig();
    }
    try {
      return mergeFromDisk(JSON.parse(raw));
    } catch {
      // Corrupt JSON. The quarantine-and-recheck runs behind the write
      // queue: a concurrent save() may land between this read and the
      // queued step actually running, replacing the corrupt file with a
      // fresh valid one. Without the queue, quarantine() would rename that
      // just-written valid file away, silently losing the save. Re-reading
      // inside the queue means we only ever quarantine content that is
      // still corrupt at the moment we're serialized to act on it.
      return this.enqueue(() => this.recoverFromCorruptFile());
    }
  }

  /**
   * Re-read and re-check the file, then quarantine only if it is still
   * corrupt. Always called behind `writeQueue` (see `load()`) so it can't
   * race a concurrent `save()`.
   */
  private async recoverFromCorruptFile(): Promise<SpeechConfig> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch {
      return cloneDefaultConfig();
    }
    try {
      // A concurrent save() already replaced the corrupt content with
      // valid JSON while we were waiting on the queue. Nothing to
      // quarantine — load the now-current file instead.
      return mergeFromDisk(JSON.parse(raw));
    } catch {
      await this.quarantine();
      return cloneDefaultConfig();
    }
  }

  /**
   * Persist a speech config to disk. Atomic write via unique-temp+rename,
   * serialized behind the write queue so two concurrent saves can't race the
   * rename. Write errors propagate to the caller.
   */
  async save(config: SpeechConfig): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      // Randomize the temp path so concurrent saves don't write the same
      // file and corrupt/interleave each other's contents (or ENOENT on the
      // loser's rename after the winner already consumed a shared `.tmp`).
      const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, JSON.stringify(config, null, 2));
      try {
        await rename(tmpPath, this.filePath);
      } catch (err) {
        // Don't leave the temp file behind if the rename fails.
        await unlink(tmpPath).catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Rename a corrupt file aside so a subsequent `save()` starts clean and
   * the bad content isn't lost. Best-effort: if the rename itself fails
   * (e.g. the file vanished between the corrupt-JSON detection and here),
   * `load()` still returns defaults regardless.
   */
  private async quarantine(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const quarantinePath = `${this.filePath}.corrupt-${timestamp}`;
    await rename(this.filePath, quarantinePath).catch(() => {});
  }
}

function cloneDefaultConfig(): SpeechConfig {
  return {
    stt: { ...DEFAULT_SPEECH_CONFIG.stt },
    tts: { ...DEFAULT_SPEECH_CONFIG.tts },
    realtime: { ...DEFAULT_SPEECH_CONFIG.realtime },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickStt(raw: unknown): SpeechConfigPatch['stt'] {
  if (!isPlainObject(raw)) return undefined;
  const value: NonNullable<SpeechConfigPatch['stt']> = {};
  if (typeof raw.provider === 'string') value.provider = raw.provider;
  if (typeof raw.model === 'string') value.model = raw.model;
  if (typeof raw.language === 'string') value.language = raw.language;
  return value;
}

function pickTts(raw: unknown): SpeechConfigPatch['tts'] {
  if (!isPlainObject(raw)) return undefined;
  const value: NonNullable<SpeechConfigPatch['tts']> = {};
  if (typeof raw.provider === 'string') value.provider = raw.provider;
  if (typeof raw.model === 'string') value.model = raw.model;
  if (typeof raw.voice === 'string') value.voice = raw.voice;
  if (typeof raw.speed === 'number') value.speed = raw.speed;
  return value;
}

function pickRealtime(raw: unknown): SpeechConfigPatch['realtime'] {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.provider === 'string' || raw.provider === null) {
    return { provider: raw.provider };
  }
  return undefined;
}

/**
 * Build a `SpeechConfigPatch` from known keys only (unknown top-level and
 * nested keys are dropped, never spread) and merge it over
 * `DEFAULT_SPEECH_CONFIG` via `mergeSpeechConfig`. A field absent from disk
 * (or the whole file not even being an object) simply keeps its default —
 * this is what makes a file written before a new key existed, or missing
 * `realtime` entirely, load with that key defaulted.
 */
function mergeFromDisk(parsed: unknown): SpeechConfig {
  const obj = isPlainObject(parsed) ? parsed : {};
  const patch: SpeechConfigPatch = {
    stt: pickStt(obj.stt),
    tts: pickTts(obj.tts),
    realtime: pickRealtime(obj.realtime),
  };
  return mergeSpeechConfig(DEFAULT_SPEECH_CONFIG, patch);
}
