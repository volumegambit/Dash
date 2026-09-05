import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@dash/agent';
import { ROSTER_TOKEN_BUDGET, estimateTokens } from '@dash/swarm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayAgentConfig } from './agent-registry.js';
import {
  type SubagentDefinitionRegistry,
  createSubagentDefinitionRegistry,
  definitionToType,
} from './subagent-definitions.js';

/** A minimal valid definition file. `extra` adds frontmatter lines. */
function def(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody of ${name}.`;
}

async function writeDef(dir: string, file: string, contents: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, contents);
  return path;
}

describe('subagent definition registry', () => {
  let dataDir: string;
  let workspace: string;
  let warnings: string[];
  let configs: Record<string, GatewayAgentConfig>;
  let pluginFiles: Array<{ file: string; namespace: string }>;

  const AGENT_ID = 'agent-1';

  function makeRegistry(): SubagentDefinitionRegistry {
    return createSubagentDefinitionRegistry({
      dataDir,
      getPluginAgentDefFiles: () => pluginFiles,
      getAgentConfig: (id) => configs[id],
      logger: { warn: (m) => warnings.push(m) },
    });
  }

  /** `<dataDir>/subagents/<agentName>` for the default test agent. */
  function agentDir(): string {
    return join(dataDir, 'subagents', 'scout');
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dash-subagent-defs-'));
    workspace = await mkdtemp(join(tmpdir(), 'dash-subagent-ws-'));
    warnings = [];
    pluginFiles = [];
    configs = {
      [AGENT_ID]: {
        name: 'scout',
        model: 'anthropic/claude-sonnet-4-5',
        systemPrompt: 'p',
        workspace,
      },
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('resolves the built-ins when no definition files exist', async () => {
    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    expect(resolver.list().map((t) => t.name)).toEqual(['general-purpose', 'Explore', 'Plan']);
    expect(resolver.resolve('Explore')?.source).toBe('builtin');
    // A workspace with no .dash/.claude dirs and an absent per-agent dir are
    // NOT errors — nothing is logged.
    expect(warnings).toEqual([]);
  });

  it('workspace .dash beats .claude beats the per-agent dir beats a built-in', async () => {
    await writeDef(agentDir(), 'reviewer.md', def('reviewer', 'from the agent dir'));
    await writeDef(
      agentDir(),
      'general-purpose.md',
      def('general-purpose', 'a replacement general-purpose'),
    );
    await writeDef(join(workspace, '.claude', 'agents'), 'reviewer.md', def('reviewer', 'from cc'));
    const dashFile = await writeDef(
      join(workspace, '.dash', 'agents'),
      'reviewer.md',
      def('reviewer', 'from dash'),
    );

    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    const reviewer = resolver.resolve('reviewer');
    expect(reviewer).toMatchObject({
      name: 'reviewer',
      description: 'from dash',
      source: 'workspace',
      location: dashFile,
    });
    // A bare name defined at a higher layer shadows the built-in of that name.
    expect(resolver.resolve('general-purpose')).toMatchObject({
      description: 'a replacement general-purpose',
      source: 'agent',
    });
  });

  // Spec §6.3: a built-in can be shadowed by a user definition of the same
  // name. The `name` grammar is lowercase-only, so `Explore` is unspellable in
  // a file — `explore.md` must therefore be CANONICALISED onto the built-in's
  // spelling, not added next to it as a second, near-identical type.
  it('canonicalises a lowercase file name onto the built-in it shadows', async () => {
    await writeDef(agentDir(), 'explore.md', def('explore', 'my own explorer'));

    const registry = makeRegistry();
    const resolver = await registry.resolverFor(AGENT_ID);
    expect(resolver.resolve('Explore')).toMatchObject({
      name: 'Explore',
      description: 'my own explorer',
      source: 'agent',
    });
    // No second entry under the lowercase spelling.
    expect(resolver.resolve('explore')).toBeUndefined();
    expect(resolver.list().map((t) => t.name)).toEqual(['general-purpose', 'Explore', 'Plan']);
    const listing = await registry.listFor(AGENT_ID);
    expect(listing.types.filter((t) => t.name.toLowerCase() === 'explore')).toHaveLength(2);
    expect(listing.types.some((t) => t.name === 'explore')).toBe(false);
  });

  it('a workspace definition shadows a built-in of the same name', async () => {
    await writeDef(
      join(workspace, '.dash', 'agents'),
      'general-purpose.md',
      def('general-purpose', 'the project general-purpose'),
    );

    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    expect(resolver.resolve('general-purpose')).toMatchObject({
      description: 'the project general-purpose',
      source: 'workspace',
    });
  });

  it('.claude/agents beats the per-agent dir when .dash has no file', async () => {
    await writeDef(agentDir(), 'reviewer.md', def('reviewer', 'from the agent dir'));
    await writeDef(join(workspace, '.claude', 'agents'), 'reviewer.md', def('reviewer', 'from cc'));

    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    expect(resolver.resolve('reviewer')).toMatchObject({
      description: 'from cc',
      source: 'workspace',
    });
  });

  it('plugin definitions are namespaced and never shadow a bare name', async () => {
    const pluginFile = await writeDef(
      join(dataDir, 'plugins', 'demo', 'agents'),
      'reviewer.md',
      def('reviewer', 'the demo plugin reviewer'),
    );
    pluginFiles = [{ file: pluginFile, namespace: 'demo' }];
    await writeDef(agentDir(), 'reviewer.md', def('reviewer', 'from the agent dir'));

    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    expect(resolver.resolve('demo:reviewer')).toMatchObject({
      name: 'demo:reviewer',
      description: 'the demo plugin reviewer',
      source: 'plugin',
      location: pluginFile,
    });
    // The bare name is untouched by the plugin definition of the same base name.
    expect(resolver.resolve('reviewer')).toMatchObject({
      description: 'from the agent dir',
      source: 'agent',
    });
  });

  it("narrows plugin definitions by the agent's plugin selection", async () => {
    const a = await writeDef(join(dataDir, 'p', 'a'), 'x.md', def('x', 'from alpha'));
    const b = await writeDef(join(dataDir, 'p', 'b'), 'x.md', def('x', 'from beta'));
    pluginFiles = [
      { file: a, namespace: 'alpha' },
      { file: b, namespace: 'beta' },
    ];
    configs[AGENT_ID] = { ...configs[AGENT_ID], plugins: ['beta'] };

    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    expect(resolver.resolve('alpha:x')).toBeUndefined();
    expect(resolver.resolve('beta:x')).toMatchObject({ description: 'from beta' });
  });

  it('allowedTypes hides everything else, including general-purpose', async () => {
    await writeDef(agentDir(), 'reviewer.md', def('reviewer', 'r'));
    configs[AGENT_ID] = { ...configs[AGENT_ID], subagents: { allowedTypes: ['Explore'] } };

    const registry = makeRegistry();
    const resolver = await registry.resolverFor(AGENT_ID);
    expect(resolver.list().map((t) => t.name)).toEqual(['Explore']);
    expect(resolver.resolve('general-purpose')).toBeUndefined();
    expect(resolver.resolve('reviewer')).toBeUndefined();
    const listing = await registry.listFor(AGENT_ID);
    expect(listing.types.map((t) => t.name)).toEqual(['Explore']);
    expect(listing.unknownAllowedTypes).toEqual([]);
  });

  // RULING 1: a case typo in allowedTypes used to yield an orchestrator that
  // could spawn nothing, silently. The registry is the only layer that knows
  // every resolvable name, so it validates here — reporting, never throwing.
  it('reports allowedTypes entries matching no type, keeping the valid ones', async () => {
    configs[AGENT_ID] = {
      ...configs[AGENT_ID],
      subagents: { allowedTypes: ['Explore', 'explore', 'reviewr'] },
    };

    const registry = makeRegistry();
    const listing = await registry.listFor(AGENT_ID);
    expect(listing.unknownAllowedTypes).toEqual(['explore', 'reviewr']);
    // Named in a warning: the agent AND the unmatched entries.
    const warned = warnings.filter((w) => w.includes('allowedTypes'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('scout');
    expect(warned[0]).toContain('explore');
    expect(warned[0]).toContain('reviewr');
    // Not fatal: the valid entry still resolves.
    const resolver = await registry.resolverFor(AGENT_ID);
    expect(resolver.list().map((t) => t.name)).toEqual(['Explore']);
  });

  // RULING 4: one bad file must never take the whole roster down.
  it('skips a malformed file with a warning naming the file and the error', async () => {
    const bad = await writeDef(agentDir(), 'bad.md', '---\nname: bad\n---\nno description');
    const unbalanced = await writeDef(
      agentDir(),
      'unbalanced.md',
      def('unbalanced', 'd', 'tools: agent(a)), read\n'),
    );
    await writeDef(agentDir(), 'good.md', def('good', 'a good one'));

    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    expect(resolver.resolve('good')).toMatchObject({ description: 'a good one' });
    expect(resolver.resolve('bad')).toBeUndefined();
    expect(resolver.resolve('unbalanced')).toBeUndefined();
    expect(warnings.some((w) => w.includes(bad) && w.includes('description is required'))).toBe(
      true,
    );
    expect(
      warnings.some(
        (w) => w.includes(unbalanced) && w.includes('unbalanced parentheses in tools list'),
      ),
    ).toBe(true);
  });

  it('caches until invalidate, then picks up a newly written file and notifies', async () => {
    const registry = makeRegistry();
    const seen: Array<string | undefined> = [];
    const unsubscribe = registry.onChange((id) => seen.push(id));

    expect((await registry.resolverFor(AGENT_ID)).resolve('fresh')).toBeUndefined();
    await writeDef(agentDir(), 'fresh.md', def('fresh', 'brand new'));
    // Still cached — the write alone does not re-scan.
    expect((await registry.resolverFor(AGENT_ID)).resolve('fresh')).toBeUndefined();

    registry.invalidate(AGENT_ID);
    expect(seen).toEqual([AGENT_ID]);
    expect((await registry.resolverFor(AGENT_ID)).resolve('fresh')).toMatchObject({
      description: 'brand new',
      source: 'agent',
    });

    // invalidate() with no id clears every agent and notifies with undefined.
    registry.invalidate();
    expect(seen).toEqual([AGENT_ID, undefined]);
    unsubscribe();
    registry.invalidate();
    expect(seen).toEqual([AGENT_ID, undefined]);
  });

  // RULING 3: over budget warns ONCE and keeps going — no truncation, no throw.
  it('warns once, largest first, when the roster exceeds the token budget', async () => {
    await writeDef(agentDir(), 'huge.md', def('huge', 'H'.repeat(70_000)));
    await writeDef(agentDir(), 'big.md', def('big', 'B'.repeat(20_000)));

    const registry = makeRegistry();
    const resolver = await registry.resolverFor(AGENT_ID);
    // Nothing is dropped.
    expect(resolver.resolve('huge')).toBeDefined();
    expect(resolver.resolve('big')).toBeDefined();

    const overBudget = warnings.filter((w) => w.includes('budget'));
    expect(overBudget).toHaveLength(1);
    expect(overBudget[0]).toContain(String(ROSTER_TOKEN_BUDGET));
    expect(overBudget[0].indexOf('huge')).toBeLessThan(overBudget[0].indexOf('big'));

    // A second read of the SAME cached build must not re-warn.
    await registry.listFor(AGENT_ID);
    expect(warnings.filter((w) => w.includes('budget'))).toHaveLength(1);
  });

  // The budget must measure the string that SHIPS (`buildRosterText`), which
  // adds `- <name>: ` and ` (Tools: …)` per entry. Many small definitions blow
  // the budget while the descriptions alone stay under it.
  it('counts the roster line overhead, not just the descriptions', async () => {
    for (let i = 0; i < 40; i++) {
      const name = `bulk-${String(i).padStart(2, '0')}`;
      await writeDef(
        agentDir(),
        `${name}.md`,
        def(name, 'D'.repeat(1470), 'tools: read, grep, find, ls, web_fetch\n'),
      );
    }

    const registry = makeRegistry();
    const listing = await registry.listFor(AGENT_ID);
    // The OLD metric (descriptions only) is under budget — so this test fails
    // the moment the check regresses to summing descriptions.
    const descriptionsOnly = estimateTokens(listing.types.map((t) => t.description).join(''));
    expect(descriptionsOnly).toBeLessThanOrEqual(ROSTER_TOKEN_BUDGET);
    expect(warnings.filter((w) => w.includes('budget'))).toHaveLength(1);
  });

  // Agent names are operator-supplied and unvalidated by the registry; B8
  // WRITES definition files into this dir, so traversal here would be an
  // arbitrary-write primitive.
  it('cannot escape the subagents root via a traversing agent name', async () => {
    const root = join(dataDir, 'subagents');
    const escaped = makeRegistry().perAgentDir('../../etc');
    expect(escaped.startsWith(`${root}/`)).toBe(true);
    expect(escaped).not.toContain('..');

    // The build reads from the SAME sanitised dir (not from the raw name).
    configs[AGENT_ID] = { ...configs[AGENT_ID], name: '../../etc' };
    await writeDef(escaped, 'sanitised.md', def('sanitised', 'inside the root'));
    const resolver = await makeRegistry().resolverFor(AGENT_ID);
    expect(resolver.resolve('sanitised')).toMatchObject({ description: 'inside the root' });
  });

  it('lists shadowed definitions with the winner that shadowed them', async () => {
    const winner = await writeDef(agentDir(), 'general-purpose.md', def('general-purpose', 'mine'));

    const listing = await makeRegistry().listFor(AGENT_ID);
    const entries = listing.types.filter((t) => t.name === 'general-purpose');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ description: 'mine', source: 'agent' });
    expect(entries[0].shadowedBy).toBeUndefined();
    expect(entries[1]).toMatchObject({ source: 'builtin', shadowedBy: winner });
  });

  it('does not cache a failed build', async () => {
    let broken = true;
    const registry = createSubagentDefinitionRegistry({
      dataDir,
      getPluginAgentDefFiles: () => pluginFiles,
      getAgentConfig: (id) => {
        if (broken) throw new Error('registry is mid-write');
        return configs[id];
      },
      logger: { warn: (m) => warnings.push(m) },
    });
    await expect(registry.resolverFor(AGENT_ID)).rejects.toThrow('registry is mid-write');
    broken = false;
    const resolver = await registry.resolverFor(AGENT_ID);
    expect(resolver.list().map((t) => t.name)).toContain('Explore');
  });

  it('falls back to the built-ins for an unknown agent id', async () => {
    const resolver = await makeRegistry().resolverFor('nope');
    expect(resolver.list().map((t) => t.name)).toEqual(['general-purpose', 'Explore', 'Plan']);
  });

  it('exposes the per-agent definition dir', () => {
    expect(makeRegistry().perAgentDir('scout')).toBe(join(dataDir, 'subagents', 'scout'));
  });

  // B3 made the mapping SAFE; B8 made it a WRITE path, which makes it also have
  // to be INJECTIVE. `a/b` and `a_b` both flatten to `a_b`, so without a
  // disambiguator two agents would share one writable dir and each could read
  // and DELETE the other's definitions.
  it('never maps two distinct agent names onto one directory', () => {
    const registry = makeRegistry();
    const flattened = registry.perAgentDir('a/b');
    const literal = registry.perAgentDir('a_b');
    expect(flattened).not.toBe(literal);
    expect(flattened.startsWith(`${join(dataDir, 'subagents', 'a_b')}-`)).toBe(true);
    // Deterministic: the same name always resolves to the same directory, or a
    // gateway restart would orphan every definition the operator wrote.
    expect(registry.perAgentDir('a/b')).toBe(flattened);
    // The unchanged common case keeps its readable, suffix-free directory.
    expect(literal).toBe(join(dataDir, 'subagents', 'a_b'));
    expect(registry.perAgentDir('scout 2')).toBe(join(dataDir, 'subagents', 'scout 2'));
  });
});

describe('definitionToType', () => {
  it('copies the definition fields and marks it resumable and memory-carrying', () => {
    const definition: AgentDefinition = {
      name: 'reviewer',
      description: 'reviews',
      systemPrompt: 'You review.',
      tools: ['read', 'grep'],
      disallowedTools: ['write'],
      model: 'inherit',
      skills: ['conventions'],
      maxTurns: 40,
      background: true,
      isolation: 'worktree',
      ignoredKeys: ['color'],
      source: 'workspace',
      location: '/ws/.dash/agents/reviewer.md',
    };
    expect(definitionToType(definition)).toEqual({
      name: 'reviewer',
      description: 'reviews',
      systemPrompt: 'You review.',
      tools: ['read', 'grep'],
      disallowedTools: ['write'],
      model: 'inherit',
      skills: ['conventions'],
      maxTurns: 40,
      background: true,
      isolation: 'worktree',
      skipMemory: false,
      oneShot: false,
      source: 'workspace',
      location: '/ws/.dash/agents/reviewer.md',
    });
  });

  it('omits absent optional fields', () => {
    expect(
      definitionToType({
        name: 'a',
        description: 'd',
        systemPrompt: 'b',
        ignoredKeys: [],
        source: 'plugin',
        location: '/p/a.md',
      }),
    ).toEqual({
      name: 'a',
      description: 'd',
      systemPrompt: 'b',
      skipMemory: false,
      oneShot: false,
      source: 'plugin',
      location: '/p/a.md',
    });
  });
});
