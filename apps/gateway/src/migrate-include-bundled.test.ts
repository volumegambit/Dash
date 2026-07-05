import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from './agent-registry.js';
import { migrateIncludeBundled } from './migrate-include-bundled.js';

const WIRING = {
  'dash-dev': { builtin: true },
  'dash-meta': { builtin: true },
  'user-plugin': { builtin: false },
} as Parameters<typeof migrateIncludeBundled>[1];

const noopLogger = { info: () => {}, warn: () => {} };

describe('migrateIncludeBundled', () => {
  let dir: string;
  let registry: AgentRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mig-'));
    registry = new AgentRegistry(join(dir, 'agents.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rewrites an opted-out agent to the non-builtin plugin list', async () => {
    const a = registry.register({
      name: 'a',
      model: 'm',
      systemPrompt: 's',
      skills: { includeBundled: false } as { paths?: string[] },
    });
    const n = await migrateIncludeBundled(registry, WIRING, noopLogger);
    expect(n).toBe(1);
    const cfg = registry.get(a.id)?.config;
    expect(cfg?.plugins).toEqual(['user-plugin']);
    expect((cfg?.skills as Record<string, unknown>).includeBundled).toBeUndefined();
  });

  it('only strips the flag when a plugins list already exists', async () => {
    const a = registry.register({
      name: 'b',
      model: 'm',
      systemPrompt: 's',
      skills: { includeBundled: false } as { paths?: string[] },
      plugins: ['user-plugin'],
    });
    await migrateIncludeBundled(registry, WIRING, noopLogger);
    expect(registry.get(a.id)?.config.plugins).toEqual(['user-plugin']);
  });

  it('strips a true flag without touching plugins', async () => {
    const a = registry.register({
      name: 'c',
      model: 'm',
      systemPrompt: 's',
      skills: { includeBundled: true } as { paths?: string[] },
    });
    const n = await migrateIncludeBundled(registry, WIRING, noopLogger);
    expect(n).toBe(1);
    expect(registry.get(a.id)?.config.plugins).toBeUndefined();
  });

  it('is idempotent — second run migrates nothing', async () => {
    registry.register({
      name: 'd',
      model: 'm',
      systemPrompt: 's',
      skills: { includeBundled: false } as { paths?: string[] },
    });
    await migrateIncludeBundled(registry, WIRING, noopLogger);
    expect(await migrateIncludeBundled(registry, WIRING, noopLogger)).toBe(0);
  });

  it('no-ops for agents without the flag', async () => {
    registry.register({ name: 'e', model: 'm', systemPrompt: 's' });
    expect(await migrateIncludeBundled(registry, WIRING, noopLogger)).toBe(0);
  });
});
