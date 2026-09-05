import {
  ALWAYS_AVAILABLE_TOOLS,
  DEFAULT_TOOL_NAMES,
  type ParentToolContext,
  UNIVERSE,
  parentBuiltinTools,
  preloadSkills,
  resolveChildModel,
  resolveChildTools,
} from './resolve-spawn.js';

const parent: ParentToolContext = {
  builtinTools: [
    'read',
    'bash',
    'edit',
    'grep',
    'find',
    'ls',
    'web_fetch',
    'load_skill',
    'todowrite',
  ],
  mcpTools: ['github__search', 'github__pr', 'slack__post'],
  depth: 0,
  maxDepth: 3,
};

describe('resolveChildTools', () => {
  it('inherits everything when tools is omitted', () => {
    expect(resolveChildTools({}, parent)).toEqual({
      tools: parent.builtinTools,
      mcpTools: parent.mcpTools,
      spawnableTypes: undefined,
      canSpawn: true,
    });
  });

  it('intersects with the parent and never escalates', () => {
    expect(resolveChildTools({ tools: ['read', 'write', 'mcp__github'] }, parent)).toEqual({
      tools: ['read'],
      mcpTools: ['github__search', 'github__pr'],
      spawnableTypes: undefined,
      canSpawn: false,
    });
  });

  it('applies disallowedTools first and supports mcp__* and mcp__server__tool', () => {
    expect(resolveChildTools({ disallowedTools: ['mcp__slack', 'bash'] }, parent).mcpTools).toEqual(
      ['github__search', 'github__pr'],
    );
    expect(resolveChildTools({ disallowedTools: ['mcp__slack', 'bash'] }, parent).tools).not.toContain(
      'bash',
    );
    expect(
      resolveChildTools({ tools: ['mcp__*'], disallowedTools: ['mcp__github__pr'] }, parent),
    ).toMatchObject({ tools: [], mcpTools: ['github__search', 'slack__post'] });
  });

  it('agent(a, b) restricts spawnable types; depth limit removes spawning', () => {
    expect(resolveChildTools({ tools: ['read', 'agent(Explore, Plan)'] }, parent)).toMatchObject({
      spawnableTypes: ['Explore', 'Plan'],
      canSpawn: true,
    });
    expect(
      resolveChildTools({ tools: ['read', 'agent(Explore)'] }, { ...parent, depth: 3 }).canSpawn,
    ).toBe(false);
  });

  it('throws on zero tools naming unresolved entries', () => {
    expect(() => resolveChildTools({ tools: ['write', 'mcp__nope'] }, parent)).toThrow(
      'Agent would be spawned with zero tools: write, mcp__nope',
    );
  });

  // --- Ruling 6: no privilege escalation, ever ---

  it('never grants a builtin or an MCP server the parent lacks, including via mcp__*', () => {
    const held = new Set([...parent.builtinTools, ...parent.mcpTools]);
    const resolved = resolveChildTools(
      { tools: ['mcp__*', 'bash', 'write', 'web_search', 'mcp__jira__create'] },
      parent,
    );
    expect(resolved.tools).toEqual(['bash']);
    expect(resolved.mcpTools).toEqual(parent.mcpTools);
    for (const granted of [...resolved.tools, ...resolved.mcpTools]) {
      expect(held.has(granted)).toBe(true);
    }
  });

  it('mcp__* over a parent with no MCP tools grants no MCP at all', () => {
    const noMcp: ParentToolContext = { ...parent, mcpTools: [] };
    expect(resolveChildTools({ tools: ['read', 'mcp__*'] }, noMcp).mcpTools).toEqual([]);
    expect(() => resolveChildTools({ tools: ['mcp__*'] }, noMcp)).toThrow(
      'Agent would be spawned with zero tools: mcp__*',
    );
  });

  it('mcp__server matches only that server; mcp__server__tool only that tool', () => {
    expect(resolveChildTools({ tools: ['mcp__slack'] }, parent).mcpTools).toEqual(['slack__post']);
    expect(resolveChildTools({ tools: ['mcp__github__pr'] }, parent).mcpTools).toEqual([
      'github__pr',
    ]);
  });

  it('a bare agent entry allows spawning with no type restriction', () => {
    expect(resolveChildTools({ tools: ['read', 'agent'] }, parent)).toMatchObject({
      tools: ['read'],
      spawnableTypes: undefined,
      canSpawn: true,
    });
  });

  it('disallowedTools: agent removes spawning even when the tools list asks for it', () => {
    expect(
      resolveChildTools({ tools: ['read', 'agent'], disallowedTools: ['agent'] }, parent).canSpawn,
    ).toBe(false);
  });

  it('a spawn-only definition is not a zero-tool spawn, but is at the depth limit', () => {
    expect(resolveChildTools({ tools: ['agent(Explore)'] }, parent)).toMatchObject({
      tools: [],
      canSpawn: true,
    });
    expect(() =>
      resolveChildTools({ tools: ['agent(Explore)'] }, { ...parent, depth: 3 }),
    ).toThrow(/zero tools/);
  });

  it('throws when disallowedTools removes everything the parent holds', () => {
    const tiny: ParentToolContext = { ...parent, builtinTools: ['read'], mcpTools: [] };
    expect(() => resolveChildTools({ disallowedTools: ['read', 'agent'] }, tiny)).toThrow(
      'Agent would be spawned with zero tools: read, agent',
    );
  });

  it('deduplicates repeated entries and overlapping MCP patterns', () => {
    expect(
      resolveChildTools({ tools: ['read', 'read', 'mcp__github', 'mcp__github__pr'] }, parent),
    ).toMatchObject({ tools: ['read'], mcpTools: ['github__search', 'github__pr'] });
  });
});

describe('parentBuiltinTools', () => {
  it('defaults to the orchestrator default grant plus the always-available tools', () => {
    expect(parentBuiltinTools(undefined)).toEqual([
      ...DEFAULT_TOOL_NAMES,
      ...ALWAYS_AVAILABLE_TOOLS,
    ]);
  });

  it('keeps only spawnable universe entries and never invents a tool', () => {
    expect(parentBuiltinTools(['read', 'create_skill', 'mcp_add_server', 'web_search'])).toEqual([
      'read',
      'web_search',
      ...ALWAYS_AVAILABLE_TOOLS,
    ]);
  });

  it('does not duplicate an always-available tool the parent already lists', () => {
    expect(parentBuiltinTools(['read', 'load_skill'])).toEqual([
      'read',
      'load_skill',
      ...ALWAYS_AVAILABLE_TOOLS.filter((t) => t !== 'load_skill'),
    ]);
  });

  it('UNIVERSE is the spawnable builtin set', () => {
    expect([...UNIVERSE]).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'web_fetch',
      'web_search',
    ]);
  });
});

describe('resolveChildModel', () => {
  it('resolves model precedence and aliases', () => {
    expect(resolveChildModel({ parentModel: 'p/m', aliases: {} })).toEqual({ model: 'p/m' });
    expect(resolveChildModel({ definition: 'inherit', parentModel: 'p/m', aliases: {} })).toEqual({
      model: 'p/m',
    });
    expect(
      resolveChildModel({
        definition: 'anthropic/claude-sonnet-5',
        requested: 'haiku',
        parentModel: 'p/m',
        aliases: { haiku: 'anthropic/claude-haiku-4-5' },
      }),
    ).toEqual({ model: 'anthropic/claude-haiku-4-5' });
    expect(resolveChildModel({ requested: 'opus', parentModel: 'p/m', aliases: {} })).toEqual({
      model: 'p/m',
      warning: 'alias "opus" is not configured (subagents.modelAliases); using the parent model',
    });
  });

  it('uses the definition model when the call asks for nothing', () => {
    expect(
      resolveChildModel({ definition: 'anthropic/claude-sonnet-5', parentModel: 'p/m', aliases: {} }),
    ).toEqual({ model: 'anthropic/claude-sonnet-5' });
  });

  // --- Ruling 5: an explicit per-call `inherit` beats a type-level pin ---

  it('per-call inherit overrides a type-level model pin', () => {
    expect(
      resolveChildModel({
        requested: 'inherit',
        definition: 'anthropic/claude-sonnet-5',
        parentModel: 'p/m',
        aliases: { sonnet: 'anthropic/claude-sonnet-5' },
      }),
    ).toEqual({ model: 'p/m' });
  });

  it('resolves an alias at the definition level too', () => {
    expect(
      resolveChildModel({
        definition: 'haiku',
        parentModel: 'p/m',
        aliases: { haiku: 'anthropic/claude-haiku-4-5' },
      }),
    ).toEqual({ model: 'anthropic/claude-haiku-4-5' });
  });

  it('warns and inherits when a definition-level alias is unconfigured', () => {
    expect(resolveChildModel({ definition: 'fable', parentModel: 'p/m', aliases: {} })).toEqual({
      model: 'p/m',
      warning: 'alias "fable" is not configured (subagents.modelAliases); using the parent model',
    });
  });
});

describe('preloadSkills', () => {
  it('preloads skills by exact name and throws on unknown', () => {
    expect(preloadSkills(['a'], [{ name: 'a', content: 'A!' }])).toBe(
      '\n\n# Preloaded skill: a\nA!',
    );
    expect(() => preloadSkills(['zz'], [])).toThrow('Unknown skill "zz" in definition skills list');
  });

  it('returns an empty string when the definition names no skills', () => {
    expect(preloadSkills(undefined, [{ name: 'a', content: 'A!' }])).toBe('');
    expect(preloadSkills([], [{ name: 'a', content: 'A!' }])).toBe('');
  });

  it('concatenates several skills in definition order', () => {
    expect(
      preloadSkills(
        ['b', 'a'],
        [
          { name: 'a', content: 'A!' },
          { name: 'b', content: 'B!' },
        ],
      ),
    ).toBe('\n\n# Preloaded skill: b\nB!\n\n# Preloaded skill: a\nA!');
  });
});
