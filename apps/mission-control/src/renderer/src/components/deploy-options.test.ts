import { AGENT_TOOL_NAMES } from '@dash/agent';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_TOOLS, TOOL_DESCRIPTIONS, TOOL_GROUPS } from './deploy-options.js';

// Note: AVAILABLE_MODELS was removed in the dynamic-model-discovery
// rewrite. The model list is now served by the gateway's GET /models
// endpoint with the curated allow-list in @dash/models. See
// packages/models/src/supported-models.ts and bootstrap-models.ts.

describe('AVAILABLE_TOOLS', () => {
  it('has at least one tool', () => {
    expect(AVAILABLE_TOOLS.length).toBeGreaterThanOrEqual(1);
  });

  it('every tool has a value and label', () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(tool.value).toBeTruthy();
      expect(tool.label).toBeTruthy();
    }
  });

  it('tool values are unique', () => {
    const values = AVAILABLE_TOOLS.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('tool values use lowercase alphanumeric with underscores', () => {
    for (const tool of AVAILABLE_TOOLS) {
      expect(tool.value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('includes core tools', () => {
    const values = AVAILABLE_TOOLS.map((t) => t.value);
    expect(values).toContain('bash');
    expect(values).toContain('read');
    expect(values).toContain('write');
    expect(values).toContain('edit');
    expect(values).toContain('ls');
  });

  it('includes create_skill in a tool group', () => {
    const allGroupTools = TOOL_GROUPS.flatMap((g) => g.tools);
    expect(allGroupTools).toContain('create_skill');
  });

  it('includes create_skill in AVAILABLE_TOOLS', () => {
    const values = AVAILABLE_TOOLS.map((t) => t.value);
    expect(values).toContain('create_skill');
  });
});

describe('TOOL_DESCRIPTIONS sync with AGENT_TOOL_NAMES', () => {
  it('every tool in AGENT_TOOL_NAMES has a TOOL_DESCRIPTIONS entry', () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(TOOL_DESCRIPTIONS, `Missing TOOL_DESCRIPTIONS entry for "${name}"`).toHaveProperty(
        name,
      );
    }
  });

  it('TOOL_DESCRIPTIONS has no entries missing from AGENT_TOOL_NAMES (except auto-registered tools)', () => {
    // Tools that are auto-registered by the backend and not user-configurable.
    // They have descriptions for chat display but are not in AGENT_TOOL_NAMES.
    const autoRegistered = new Set(['task', 'load_skill']);
    const agentTools = new Set<string>(AGENT_TOOL_NAMES);
    for (const name of Object.keys(TOOL_DESCRIPTIONS)) {
      if (autoRegistered.has(name)) continue;
      expect(
        agentTools.has(name),
        `TOOL_DESCRIPTIONS has "${name}" but it's not in AGENT_TOOL_NAMES`,
      ).toBe(true);
    }
  });
});
