import { describe, expect, it } from 'vitest';
import { parseModel, buildToolsMap, ALL_OPENCODE_TOOLS } from './config-generator.js';

describe('parseModel', () => {
  it('splits provider and model correctly', () => {
    expect(parseModel('anthropic/claude-opus-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-5',
    });
  });

  it('handles model IDs with slashes (e.g. openai/gpt-4o-mini)', () => {
    expect(parseModel('openai/gpt-4o-mini')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o-mini',
    });
  });

  it('handles model IDs with multiple slashes', () => {
    expect(parseModel('vertex/gemini/pro')).toEqual({
      providerID: 'vertex',
      modelID: 'gemini/pro',
    });
  });

  it('throws if no slash present', () => {
    expect(() => parseModel('claude-opus')).toThrow('provider/model');
  });
});

describe('buildToolsMap', () => {
  it('enables all tools when undefined passed', () => {
    const map = buildToolsMap(undefined);
    for (const tool of ALL_OPENCODE_TOOLS) {
      expect(map[tool]).toBe(true);
    }
    expect(Object.keys(map)).toHaveLength(10);
  });

  it('enables only listed tools, disables others', () => {
    const map = buildToolsMap(['bash', 'read']);
    expect(map['bash']).toBe(true);
    expect(map['read']).toBe(true);
    expect(map['edit']).toBe(false);
    expect(map['web_search']).toBe(false);
    expect(map['mcp']).toBe(false);
  });

  it('always includes all 10 tool keys regardless of input', () => {
    const map = buildToolsMap(['bash']);
    expect(Object.keys(map)).toHaveLength(10);
  });

  it('returns all false when empty array passed', () => {
    const map = buildToolsMap([]);
    for (const val of Object.values(map)) {
      expect(val).toBe(false);
    }
  });
});
