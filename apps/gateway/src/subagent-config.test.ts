import { describe, expect, it } from 'vitest';
import type { GatewayAgentConfig } from './agent-registry.js';
import {
  buildDelegationSection,
  effectiveDelegation,
  isSubagentsEnabled,
  subagentCapsFromConfig,
} from './subagent-config.js';

const base: GatewayAgentConfig = {
  name: 'a',
  model: 'anthropic/claude-opus-5',
  systemPrompt: 's',
};

describe('subagent config', () => {
  it('is enabled by default, honours subagents.enabled, then legacy swarm.enabled', () => {
    expect(isSubagentsEnabled(base)).toBe(true);
    expect(isSubagentsEnabled({ ...base, subagents: { enabled: false } })).toBe(false);
    expect(isSubagentsEnabled({ ...base, swarm: { enabled: false } })).toBe(false);
    expect(
      isSubagentsEnabled({ ...base, swarm: { enabled: false }, subagents: { enabled: true } }),
    ).toBe(true);
  });

  it('delegation defaults to auto for tier 0 models, explicit otherwise, config wins', () => {
    expect(effectiveDelegation(base, 0)).toBe('auto');
    expect(effectiveDelegation(base, 1)).toBe('explicit');
    expect(effectiveDelegation(base, undefined)).toBe('explicit');
    expect(effectiveDelegation({ ...base, subagents: { delegation: 'auto' } }, 2)).toBe('auto');
    expect(effectiveDelegation({ ...base, subagents: { delegation: 'explicit' } }, 0)).toBe(
      'explicit',
    );
  });

  it('renders the delegation section with the roster', () => {
    const s = buildDelegationSection('explicit', [
      { id: 'w1', name: 'mapper', type: 'Explore', status: 'done' },
    ]);
    expect(s).toContain('# Delegation');
    expect(s).toContain('only when the user asks');
    expect(s).toContain('- mapper (Explore, done)');
    expect(buildDelegationSection('auto', [])).toContain('Delegate proactively');
  });

  it('falls back to the worker id when a child has no name, and to "none yet" when empty', () => {
    const unnamed = buildDelegationSection('auto', [{ id: 'w9', type: 'Plan', status: 'running' }]);
    expect(unnamed).toContain('- w9 (Plan, running)');
    expect(buildDelegationSection('explicit', [])).toContain('- none yet');
  });

  it('maps caps from subagents then swarm', () => {
    expect(subagentCapsFromConfig({ ...base, swarm: { maxConcurrentWorkers: 3 } })).toEqual({
      maxConcurrentWorkers: 3,
    });
    expect(
      subagentCapsFromConfig({
        ...base,
        subagents: { maxConcurrent: 2, maxPerTurn: 5 },
        swarm: { maxConcurrentWorkers: 3 },
      }),
    ).toEqual({ maxConcurrentWorkers: 2, maxWorkersPerRun: 5 });
    expect(subagentCapsFromConfig(base)).toEqual({});
  });
});
