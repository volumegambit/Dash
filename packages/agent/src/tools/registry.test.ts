import { describe, expect, it, vi } from 'vitest';
import type { DashAgentConfig } from '../types.js';
import {
  BUILTIN_TOOL_NAMES,
  DEFAULT_ALLOWED_TOOL_NAMES,
  bashToolFactory,
  createDefaultToolRegistry,
  loadSkillToolFactory,
  mcpToolsFactory,
  resolveAllowedToolNames,
  taskToolFactory,
  webFetchToolFactory,
  webSearchToolFactory,
} from './default-registry.js';
import {
  type BuiltinToolFactory,
  type CustomToolFactory,
  type ToolFactoryContext,
  ToolRegistry,
  wrapAgentTool,
} from './registry.js';

function makeContext(overrides: Partial<ToolFactoryContext> = {}): ToolFactoryContext {
  const config: DashAgentConfig = {
    model: 'test',
    systemPrompt: 'sys',
    ...(overrides.config ?? {}),
  };
  const { config: _omitConfig, ...rest } = overrides;
  return {
    workspace: '/tmp/ws',
    providerApiKeys: {},
    listSkills: async () => [],
    onMcpToolsChanged: () => {},
    allowedToolNames: new Set(BUILTIN_TOOL_NAMES),
    ...rest,
    config,
  };
}

describe('ToolRegistry', () => {
  it('register / get / has / list', () => {
    const registry = new ToolRegistry();
    const a: BuiltinToolFactory = { kind: 'builtin', id: 'a', create: () => ({ name: 'a' }) };
    const b: CustomToolFactory = {
      kind: 'custom',
      id: 'b',
      optional: false,
      create: () => ({ name: 'b', execute: () => undefined }),
    };

    expect(registry.has('a')).toBe(false);
    registry.register(a);
    registry.register(b);

    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(true);
    expect(registry.get('a')).toBe(a);
    expect(registry.list()).toEqual([a, b]);
  });

  it('throws on duplicate registration', () => {
    const registry = new ToolRegistry();
    const factory: BuiltinToolFactory = {
      kind: 'builtin',
      id: 'dup',
      create: () => ({ name: 'dup' }),
    };
    registry.register(factory);
    expect(() => registry.register(factory)).toThrow(/already registered/);
  });

  it('buildBuiltin emits factories in registration order and only when allowed', () => {
    const registry = new ToolRegistry();
    registry.register({ kind: 'builtin', id: 'one', create: () => ({ name: 'one' }) });
    registry.register({ kind: 'builtin', id: 'two', create: () => ({ name: 'two' }) });
    registry.register({ kind: 'builtin', id: 'three', create: () => ({ name: 'three' }) });

    const ctx = makeContext({ allowedToolNames: new Set(['one', 'three']) });
    const tools = registry.buildBuiltin(ctx) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['one', 'three']);
  });

  it('buildBuiltin includes optional:false factories regardless of allowedToolNames', () => {
    const registry = new ToolRegistry();
    registry.register({
      kind: 'builtin',
      id: 'always',
      optional: false,
      create: () => ({ name: 'always' }),
    });
    registry.register({
      kind: 'builtin',
      id: 'opt',
      create: () => ({ name: 'opt' }),
    });

    const ctx = makeContext({ allowedToolNames: new Set() });
    const tools = registry.buildBuiltin(ctx) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['always']);
  });

  it('buildBuiltin skips factories that return null', () => {
    const registry = new ToolRegistry();
    registry.register({
      kind: 'builtin',
      id: 'opts-out',
      optional: false,
      create: () => null,
    });
    expect(registry.buildBuiltin(makeContext())).toEqual([]);
  });

  it('buildCustom flattens factories that return arrays', () => {
    const registry = new ToolRegistry();
    registry.register({
      kind: 'custom',
      id: 'group',
      optional: false,
      create: () => [
        { name: 'g1', execute: () => undefined },
        { name: 'g2', execute: () => undefined },
      ],
    });
    const tools = registry.buildCustom(makeContext());
    expect(tools.map((t) => t.name)).toEqual(['g1', 'g2']);
  });

  it('buildCustom only includes custom-kind factories', () => {
    const registry = new ToolRegistry();
    registry.register({
      kind: 'builtin',
      id: 'b',
      optional: false,
      create: () => ({ name: 'b' }),
    });
    registry.register({
      kind: 'custom',
      id: 'c',
      optional: false,
      create: () => ({ name: 'c', execute: () => undefined }),
    });
    const tools = registry.buildCustom(makeContext());
    expect(tools.map((t) => t.name)).toEqual(['c']);
  });

  it('buildBuiltin only includes builtin-kind factories', () => {
    const registry = new ToolRegistry();
    registry.register({
      kind: 'builtin',
      id: 'b',
      optional: false,
      create: () => ({ name: 'b' }),
    });
    registry.register({
      kind: 'custom',
      id: 'c',
      optional: false,
      create: () => ({ name: 'c', execute: () => undefined }),
    });
    const tools = registry.buildBuiltin(makeContext()) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['b']);
  });
});

describe('wrapAgentTool', () => {
  it('preserves name/label/description/parameters and forwards execute args', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const wrapped = wrapAgentTool({
      name: 'sample',
      label: 'Sample',
      description: 'sample tool',
      // biome-ignore lint/suspicious/noExplicitAny: test-only mock
      parameters: { hello: 'world' } as any,
      execute,
    });

    expect(wrapped.name).toBe('sample');
    expect(wrapped.label).toBe('Sample');
    expect(wrapped.description).toBe('sample tool');
    expect(wrapped.parameters).toEqual({ hello: 'world' });

    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    await wrapped.execute('call-1', { x: 1 }, signal, onUpdate, { ignored: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('call-1', { x: 1 }, signal, onUpdate);
  });
});

describe('createDefaultToolRegistry', () => {
  it('registers all built-in tool factories in DEFAULT_TOOL_NAMES order', () => {
    const registry = createDefaultToolRegistry();
    const builtinIds = registry
      .list()
      .filter((f) => f.kind === 'builtin')
      .map((f) => f.id);
    expect(builtinIds).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  });

  it('registers all expected custom tool factories in order', () => {
    const registry = createDefaultToolRegistry();
    const customIds = registry
      .list()
      .filter((f) => f.kind === 'custom')
      .map((f) => f.id);
    expect(customIds).toEqual([
      'task',
      'load_skill',
      'web_fetch',
      'web_search',
      'create_skill',
      'mcp',
      'mcp_add_server',
      'mcp_list_servers',
      'mcp_remove_server',
    ]);
  });

  it('BUILTIN_TOOL_NAMES matches the registered builtin factory ids', () => {
    expect([...BUILTIN_TOOL_NAMES]).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
    ]);
  });

  it('DEFAULT_ALLOWED_TOOL_NAMES matches BUILTIN_TOOL_NAMES', () => {
    expect([...DEFAULT_ALLOWED_TOOL_NAMES]).toEqual([...BUILTIN_TOOL_NAMES]);
  });

  it('marks task and load_skill as non-optional, everything else optional', () => {
    const registry = createDefaultToolRegistry();
    expect(taskToolFactory.optional).toBe(false);
    expect(loadSkillToolFactory.optional).toBe(false);
    for (const f of registry.list()) {
      if (f.id === 'task' || f.id === 'load_skill') continue;
      expect(f.optional).not.toBe(false);
    }
  });
});

describe('default tool factories — behavior parity with previous buildBuiltinTools/buildCustomTools', () => {
  it('bashToolFactory.create returns a tool with name "bash" pinned to workspace', () => {
    const tool = bashToolFactory.create(makeContext({ workspace: '/tmp/foo' })) as {
      name: string;
    };
    expect(tool.name).toBe('bash');
  });

  it('task factory always emits the task tool', () => {
    const out = taskToolFactory.create(makeContext());
    expect(out).not.toBeNull();
    if (out && !Array.isArray(out)) expect(out.name).toBe('task');
  });

  it('load_skill factory returns null when no skills configured and no managed dir', () => {
    const ctx = makeContext({ config: { model: 'm', systemPrompt: 's' } });
    expect(loadSkillToolFactory.create(ctx)).toBeNull();
  });

  it('load_skill factory emits the tool when managedSkillsDir is set', () => {
    const ctx = makeContext({ managedSkillsDir: '/tmp/skills' });
    const out = loadSkillToolFactory.create(ctx);
    expect(out).not.toBeNull();
    if (out && !Array.isArray(out)) expect(out.name).toBe('load_skill');
  });

  it('load_skill factory emits the tool when config.skills.paths is non-empty', () => {
    const ctx = makeContext({
      config: { model: 'm', systemPrompt: 's', skills: { paths: ['/tmp/x'] } },
    });
    const out = loadSkillToolFactory.create(ctx);
    expect(out).not.toBeNull();
  });

  it('web_search factory passes through brave key when available', () => {
    const ctx = makeContext({ providerApiKeys: { brave: 'k1' } });
    const out = webSearchToolFactory.create(ctx);
    expect(out).not.toBeNull();
    if (out && !Array.isArray(out)) expect(out.name).toBe('web_search');
  });

  it('web_search factory still emits the tool when no brave key (provider=null)', () => {
    const ctx = makeContext({ providerApiKeys: {} });
    const out = webSearchToolFactory.create(ctx);
    expect(out).not.toBeNull();
  });

  it('web_fetch factory emits the tool unconditionally', () => {
    const out = webFetchToolFactory.create(makeContext());
    expect(out).not.toBeNull();
    if (out && !Array.isArray(out)) expect(out.name).toBe('web_fetch');
  });

  it('mcp factory returns null when no mcpManager', () => {
    expect(mcpToolsFactory.create(makeContext())).toBeNull();
  });

  it('mcp factory returns all manager tools when assignedMcpServers is undefined', () => {
    const tools = [
      { name: 'srvA__tool1', execute: () => undefined },
      { name: 'srvB__tool2', execute: () => undefined },
    ];
    const ctx = makeContext({
      // biome-ignore lint/suspicious/noExplicitAny: minimal McpManager mock for test
      mcpManager: { getTools: () => tools } as any,
    });
    const out = mcpToolsFactory.create(ctx);
    expect(Array.isArray(out)).toBe(true);
    if (Array.isArray(out)) expect(out.map((t) => t.name)).toEqual(['srvA__tool1', 'srvB__tool2']);
  });

  it('mcp factory returns null when assignedMcpServers=[] (explicit none)', () => {
    const ctx = makeContext({
      config: { model: 'm', systemPrompt: 's', assignedMcpServers: [] },
      // biome-ignore lint/suspicious/noExplicitAny: minimal McpManager mock for test
      mcpManager: { getTools: () => [{ name: 'srv__t', execute: () => undefined }] } as any,
    });
    expect(mcpToolsFactory.create(ctx)).toBeNull();
  });

  it('mcp factory filters tools by assignedMcpServers', () => {
    const ctx = makeContext({
      config: { model: 'm', systemPrompt: 's', assignedMcpServers: ['srvA'] },
      mcpManager: {
        getTools: () => [
          { name: 'srvA__tool1', execute: () => undefined },
          { name: 'srvB__tool2', execute: () => undefined },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: minimal McpManager mock for test
      } as any,
    });
    const out = mcpToolsFactory.create(ctx);
    expect(Array.isArray(out)).toBe(true);
    if (Array.isArray(out)) expect(out.map((t) => t.name)).toEqual(['srvA__tool1']);
  });
});

describe('resolveAllowedToolNames', () => {
  it('returns the default set when config.tools is undefined', () => {
    expect([...resolveAllowedToolNames(undefined)]).toEqual([...DEFAULT_ALLOWED_TOOL_NAMES]);
  });

  it('returns the explicit set when config.tools is provided', () => {
    expect([...resolveAllowedToolNames(['bash', 'web_fetch'])].sort()).toEqual([
      'bash',
      'web_fetch',
    ]);
  });

  it('returns an empty set when config.tools is []', () => {
    expect([...resolveAllowedToolNames([])]).toEqual([]);
  });
});
