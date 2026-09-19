import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayAgentConfig } from './agent-registry.js';
import { createSubagentDefinitionRegistry } from './subagent-definitions.js';
import { createSubagentRosterRefresher } from './subagent-roster-refresh.js';

/**
 * The registry→warm-backend bridge (Ruling 1). Two failure modes it exists to
 * prevent, both silent:
 *
 * 1. `createAgentTools` CAPTURES its resolver, so a `registry.resolverFor()`
 *    snapshot handed to a backend at creation time can never see a later
 *    definition write. The delegating resolver here is what makes the swap
 *    visible to a tool built minutes earlier.
 * 2. Swapping the resolver is still not enough: pi froze the tool list at
 *    `start()`, so the backend has to be poked. `refreshBackends` is that poke.
 */
describe('createSubagentRosterRefresher', () => {
  let dataDir: string;
  const warnings: string[] = [];

  function definition(name: string, description: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dash-roster-refresh-'));
    warnings.length = 0;
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function setup(configs: Record<string, GatewayAgentConfig>) {
    const registry = createSubagentDefinitionRegistry({
      dataDir,
      getPluginAgentDefFiles: () => [],
      getAgentConfig: (agentId) => configs[agentId],
      logger: { warn: (message) => warnings.push(message) },
    });
    const refreshBackends = vi.fn(async () => {});
    const refresher = createSubagentRosterRefresher({
      registry,
      refreshBackends,
      listAgentIds: () => Object.keys(configs),
      warn: (message) => warnings.push(message),
    });
    return { registry, refresher, refreshBackends };
  }

  const agentConfig = (name: string): GatewayAgentConfig => ({
    name,
    model: 'anthropic/claude-sonnet-4',
    systemPrompt: 'p',
  });

  async function writeDefinition(registryDir: string, name: string, body: string): Promise<void> {
    await mkdir(registryDir, { recursive: true });
    await writeFile(join(registryDir, `${name}.md`), body, 'utf8');
  }

  it('hands out a resolver that observes a definition written AFTER it was built', async () => {
    const { registry, refresher } = setup({ a1: agentConfig('alpha') });
    const resolver = await refresher.resolverFor('a1');
    expect(resolver.resolve('reviewer')).toBeUndefined();

    await writeDefinition(registry.perAgentDir('alpha'), 'reviewer', definition('reviewer', 'Rev'));
    registry.invalidate('a1');
    await refresher.whenIdle();

    // The SAME resolver object the tool captured, not a re-fetched one.
    expect(resolver.resolve('reviewer')?.description).toBe('Rev');
    expect(resolver.list().map((t) => t.name)).toContain('reviewer');
    refresher.dispose();
  });

  it('pokes the warm backends of exactly the invalidated agent', async () => {
    const { registry, refresher, refreshBackends } = setup({
      a1: agentConfig('alpha'),
      a2: agentConfig('beta'),
    });
    await refresher.resolverFor('a1');
    await refresher.resolverFor('a2');

    registry.invalidate('a1');
    await refresher.whenIdle();

    expect(refreshBackends.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['a1']);
    refresher.dispose();
  });

  it('refreshes every agent when invalidate names none (plugin hot-reload)', async () => {
    const { registry, refresher, refreshBackends } = setup({
      a1: agentConfig('alpha'),
      a2: agentConfig('beta'),
    });

    registry.invalidate();
    await refresher.whenIdle();

    expect(refreshBackends.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(['a1', 'a2']);
    refresher.dispose();
  });

  it('warns and keeps going when one agent refresh throws', async () => {
    const registry = createSubagentDefinitionRegistry({
      dataDir,
      getPluginAgentDefFiles: () => [],
      getAgentConfig: () => agentConfig('alpha'),
      logger: { warn: (message) => warnings.push(message) },
    });
    const refreshBackends = vi.fn(async (agentId: string) => {
      if (agentId === 'a1') throw new Error('pool exploded');
    });
    const refresher = createSubagentRosterRefresher({
      registry,
      refreshBackends,
      listAgentIds: () => ['a1', 'a2'],
      warn: (message) => warnings.push(message),
    });

    registry.invalidate();
    await expect(refresher.whenIdle()).resolves.toBeUndefined();

    expect(refreshBackends.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['a1', 'a2']);
    expect(warnings.some((w) => w.includes('pool exploded'))).toBe(true);
    refresher.dispose();
  });

  it('prime() builds every roster at boot so the budget warning fires then', async () => {
    // Spec §5.4 caps the roster the model is sent at 15,000 tokens. The registry
    // is lazy, so without an explicit boot prime this warning would first appear
    // on whatever chat happened to arrive first — see Ruling 6.
    const { registry, refresher } = setup({ a1: agentConfig('alpha') });
    const huge = 'x'.repeat(70_000);
    await writeDefinition(registry.perAgentDir('alpha'), 'huge', definition('huge', huge));

    await refresher.prime(['a1']);

    expect(warnings.some((w) => w.includes('over the 15000 budget') && w.includes('huge'))).toBe(
      true,
    );
    refresher.dispose();
  });

  it('drops the holder instead of rebuilding when the agent is gone', async () => {
    // `DELETE /agents/:id` invalidates AFTER removing the agent. Rebuilding
    // there would log "unknown agent id" on every delete and cache a
    // built-ins-only roster for an id that no longer exists.
    const configs = new Map<string, GatewayAgentConfig>([['a1', agentConfig('alpha')]]);
    const registry = createSubagentDefinitionRegistry({
      dataDir,
      getPluginAgentDefFiles: () => [],
      getAgentConfig: (agentId) => configs.get(agentId),
      logger: { warn: (message) => warnings.push(message) },
    });
    const refreshBackends = vi.fn(async () => {});
    const refresher = createSubagentRosterRefresher({
      registry,
      refreshBackends,
      listAgentIds: () => [...configs.keys()],
      warn: (message) => warnings.push(message),
    });
    await refresher.resolverFor('a1');

    configs.delete('a1');
    registry.invalidate('a1');
    await refresher.whenIdle();

    expect(refreshBackends).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.includes('unknown agent id'))).toBe(false);
    refresher.dispose();
  });

  it('dispose() stops listening', async () => {
    const { registry, refresher, refreshBackends } = setup({ a1: agentConfig('alpha') });
    await refresher.resolverFor('a1');
    refresher.dispose();

    registry.invalidate('a1');
    await refresher.whenIdle();

    expect(refreshBackends).not.toHaveBeenCalled();
  });
});
