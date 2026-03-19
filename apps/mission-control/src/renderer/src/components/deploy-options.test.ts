import { AGENT_TOOL_NAMES } from '@dash/agent';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODELS, AVAILABLE_TOOLS, TOOL_DESCRIPTIONS } from './deploy-options.js';

describe('AVAILABLE_MODELS', () => {
  it('all models use provider/model-id format', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(m.value, `${m.value} must contain a slash`).toContain('/');
    }
  });

  it('all models have a provider field', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(['anthropic', 'openai', 'google']).toContain(m.provider);
    }
  });

  it('all models have a secretKey field', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(m.secretKey).toBeTruthy();
    }
  });

  it('includes Claude, GPT, and Gemini models', () => {
    const providers = new Set(AVAILABLE_MODELS.map((m) => m.provider));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('google')).toBe(true);
  });

  it('anthropic models use anthropic-api-key', () => {
    const anthropicModels = AVAILABLE_MODELS.filter((m) => m.provider === 'anthropic');
    for (const m of anthropicModels) {
      expect(m.secretKey).toBe('anthropic-api-key');
    }
  });
});

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
