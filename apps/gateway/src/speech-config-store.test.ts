import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEECH_CONFIG, type SpeechConfig } from '@dash/speech';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpeechConfigStore } from './speech-config-store.js';

describe('SpeechConfigStore', () => {
  let dataDir: string;
  let store: SpeechConfigStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'speech-config-store-'));
    store = new SpeechConfigStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('load returns defaults when the file does not exist', async () => {
    expect(await store.load()).toEqual(DEFAULT_SPEECH_CONFIG);
  });

  it('save then load round-trips the data', async () => {
    const config: SpeechConfig = {
      stt: { provider: 'openrouter', model: 'openai/whisper-large-v3', language: 'en' },
      tts: { provider: 'openrouter', model: 'minimax/speech-2.8-turbo', voice: 'nova' },
      realtime: { provider: 'openai' },
    };
    await store.save(config);
    const loaded = await store.load();
    expect(loaded).toEqual(config);
  });

  it('load returns defaults on corrupt JSON and quarantines the file', async () => {
    const filePath = join(dataDir, 'speech.json');
    await writeFile(filePath, '{not json');

    const loaded = await store.load();
    expect(loaded).toEqual(DEFAULT_SPEECH_CONFIG);

    const entries = await readdir(dataDir);
    const quarantined = entries.filter((name) => name.startsWith('speech.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    const quarantinedContent = await readFile(join(dataDir, quarantined[0]), 'utf-8');
    expect(quarantinedContent).toBe('{not json');

    // The original path no longer holds the corrupt content.
    const remaining = entries.filter((name) => name === 'speech.json');
    expect(remaining).toHaveLength(0);
  });

  it('a persisted file merged over the defaults: a file lacking realtime loads with realtime.provider null', async () => {
    const filePath = join(dataDir, 'speech.json');
    await writeFile(
      filePath,
      JSON.stringify({
        stt: { provider: 'openrouter', model: 'openai/whisper-large-v3' },
        tts: { provider: 'openrouter', model: 'minimax/speech-2.8-turbo', voice: 'alloy' },
      }),
    );

    const loaded = await store.load();
    expect(loaded.realtime).toEqual({ provider: null });
  });

  it('a persisted file written before a new key existed merges over the defaults', async () => {
    const filePath = join(dataDir, 'speech.json');
    // Simulate an old file missing the tts.speed key and any realtime section
    // (both added after this file was written) plus an unknown legacy key
    // that must not be spread into the result.
    await writeFile(
      filePath,
      JSON.stringify({
        stt: { provider: 'legacy-provider', model: 'legacy-model' },
        legacyTopLevelKey: 'should-not-appear',
      }),
    );

    const loaded = await store.load();
    expect(loaded).toEqual({
      stt: { provider: 'legacy-provider', model: 'legacy-model' },
      tts: DEFAULT_SPEECH_CONFIG.tts,
      realtime: DEFAULT_SPEECH_CONFIG.realtime,
    });
    expect(loaded).not.toHaveProperty('legacyTopLevelKey');
  });

  it('two concurrent saves leave one valid file', async () => {
    const configA: SpeechConfig = {
      stt: { provider: 'openrouter', model: 'model-a' },
      tts: { provider: 'openrouter', model: 'model-a', voice: 'alloy' },
      realtime: { provider: null },
    };
    const configB: SpeechConfig = {
      stt: { provider: 'openrouter', model: 'model-b' },
      tts: { provider: 'openrouter', model: 'model-b', voice: 'nova' },
      realtime: { provider: null },
    };

    await Promise.all([store.save(configA), store.save(configB)]);

    const loaded = await store.load();
    // One of the two writes won; the file must be valid JSON matching one of them.
    expect([configA, configB]).toContainEqual(loaded);

    const entries = await readdir(dataDir);
    const tmpFiles = entries.filter((name) => name.includes('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('a concurrent save() is never lost to a load() quarantining stale corrupt content', async () => {
    // Regression: load()'s corrupt-JSON quarantine ran outside the write
    // queue. Sequence that lost data: load() reads corrupt bytes -> a
    // concurrent save() renames a fresh valid file into place -> load()'s
    // quarantine step then renamed that just-saved VALID file to
    // speech.json.corrupt-<ts>, leaving no speech.json and silently
    // dropping the save. The fix re-reads and re-checks behind the write
    // queue, so quarantine only ever fires on content that is still
    // corrupt when the queue actually serializes it.
    const filePath = join(dataDir, 'speech.json');
    const corruptBytes = '{not json';
    await writeFile(filePath, corruptBytes);

    const validConfig: SpeechConfig = {
      stt: { provider: 'openrouter', model: 'race-model' },
      tts: { provider: 'openrouter', model: 'race-model', voice: 'alloy' },
      realtime: { provider: null },
    };

    await Promise.all([store.load(), store.save(validConfig)]);

    // The invariant that matters: the save is never silently destroyed.
    // speech.json always ends up holding the valid saved config, whichever
    // order the race resolved in.
    const finalRaw = await readFile(filePath, 'utf-8');
    expect(JSON.parse(finalRaw)).toEqual(validConfig);
    expect(await store.load()).toEqual(validConfig);

    // If a quarantine file exists, it must hold the ORIGINAL corrupt bytes
    // -- never the valid config that was just saved (that was exactly the
    // bug: a concurrent save()'s just-written valid file getting renamed
    // away as if it were the corrupt one).
    const entries = await readdir(dataDir);
    const quarantined = entries.filter((name) => name.startsWith('speech.json.corrupt-'));
    expect(quarantined.length).toBeLessThanOrEqual(1);
    for (const name of quarantined) {
      const content = await readFile(join(dataDir, name), 'utf-8');
      expect(content).toBe(corruptBytes);
    }
  });
});
