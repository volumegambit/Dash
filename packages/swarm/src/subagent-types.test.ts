import {
  buildRosterText,
  builtinSubagentTypes,
  createStaticResolver,
  estimateTokens,
} from './subagent-types.js';

describe('built-in subagent types', () => {
  it('ships general-purpose, Explore, Plan with Claude Code semantics', () => {
    const names = builtinSubagentTypes().map((t) => t.name);
    expect(names).toEqual(['general-purpose', 'Explore', 'Plan']);
    const explore = builtinSubagentTypes().find((t) => t.name === 'Explore');
    expect(explore).toBeDefined();
    expect(explore?.tools).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'web_fetch',
      'web_search',
      'load_skill',
    ]);
    expect(explore?.skipMemory).toBe(true);
    expect(explore?.oneShot).toBe(true);
    const gp = builtinSubagentTypes().find((t) => t.name === 'general-purpose');
    expect(gp).toBeDefined();
    expect(gp?.tools).toBeUndefined();
    expect(gp?.model).toBe('inherit');
  });

  it('resolves by exact name only', () => {
    const r = createStaticResolver(builtinSubagentTypes());
    expect(r.resolve('Explore')?.name).toBe('Explore');
    expect(r.resolve('explore')).toBeUndefined();
  });

  it('builds the roster in Claude Code format', () => {
    const text = buildRosterText(builtinSubagentTypes(), (t) =>
      t.tools ? t.tools.join(', ') : '*',
    );
    const startsCorrectly = text.startsWith(
      'Available agent types and the tools they have access to:\n',
    );
    expect(startsCorrectly).toBe(true);
    expect(text).toContain('- general-purpose: General-purpose agent');
    expect(text).toContain('(Tools: *)');
    expect(text).toContain('- Explore: ');
  });

  it('estimates tokens at 4 chars per token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});
