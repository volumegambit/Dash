import {
  createMcpAddServerTool,
  createMcpListServersTool,
  createMcpRemoveServerTool,
} from './agent-tools.js';
import type { McpAgentContext, McpConfigStoreInterface } from './agent-tools.js';
import type { McpManager } from './manager.js';

function makeMockManager() {
  return {
    getTools: vi.fn().mockReturnValue([
      { name: 'github__search', label: 'github: search', description: 'Search' },
      { name: 'github__create', label: 'github: create', description: 'Create' },
    ]),
    getServerStatus: vi.fn().mockReturnValue('connected'),
    addServer: vi.fn().mockResolvedValue(undefined),
    removeServer: vi.fn().mockResolvedValue(undefined),
  } as unknown as McpManager;
}

function makeMockStore(): McpConfigStoreInterface {
  return {
    loadConfigs: vi
      .fn()
      .mockResolvedValue([
        { name: 'github', transport: { type: 'sse', url: 'https://github.com/mcp' } },
      ]),
    addConfig: vi.fn().mockResolvedValue(undefined),
    removeConfig: vi.fn().mockResolvedValue(undefined),
    isAllowed: vi.fn().mockResolvedValue(true),
  };
}

function makeMockAgentContext(assigned: string[] = []): McpAgentContext {
  const servers = [...assigned];
  return {
    assignToAgent: vi.fn(async (name: string) => {
      if (!servers.includes(name)) servers.push(name);
    }),
    unassignFromAgent: vi.fn().mockResolvedValue(false),
    getAssignedServers: vi.fn(() => servers),
  };
}

describe('mcp_add_server', () => {
  it('creates new server and assigns to agent', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    (store.loadConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([]); // no existing
    const ctx = makeMockAgentContext();
    const tool = createMcpAddServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {
      name: 'jira',
      url: 'https://jira.example.com/mcp',
      transportType: 'sse',
    });

    expect(result.details?.isError).toBeFalsy();
    expect(result.content[0].text).toContain('connected and assigned');
    expect(manager.addServer).toHaveBeenCalled();
    expect(store.addConfig).toHaveBeenCalled();
    expect(ctx.assignToAgent).toHaveBeenCalledWith('jira');
  });

  it('assigns existing server with same URL to agent', async () => {
    const manager = makeMockManager();
    const store = makeMockStore(); // has 'github' at https://github.com/mcp
    const ctx = makeMockAgentContext();
    const tool = createMcpAddServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {
      name: 'github',
      url: 'https://github.com/mcp',
      transportType: 'sse',
    });

    expect(result.details?.isError).toBeFalsy();
    expect(result.content[0].text).toContain('assigned to this agent');
    expect(manager.addServer).not.toHaveBeenCalled(); // didn't create new
    expect(ctx.assignToAgent).toHaveBeenCalledWith('github');
  });

  it('rejects existing server with different URL', async () => {
    const manager = makeMockManager();
    const store = makeMockStore(); // has 'github' at https://github.com/mcp
    const ctx = makeMockAgentContext();
    const tool = createMcpAddServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {
      name: 'github',
      url: 'https://evil.com/mcp',
      transportType: 'sse',
    });

    expect(result.details?.isError).toBe(true);
    expect(result.content[0].text).toContain('different URL');
    expect(result.content[0].text).toContain('Choose another name');
  });

  it('rejects when URL not in allowlist', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    (store.isAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const ctx = makeMockAgentContext();
    const tool = createMcpAddServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {
      name: 'bad',
      url: 'https://evil.com',
      transportType: 'sse',
    });

    expect(result.details?.isError).toBe(true);
    expect(result.content[0].text).toContain('not in the allowlist');
    expect(manager.addServer).not.toHaveBeenCalled();
  });

  it('allows stdio servers without URL check', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    (store.loadConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = makeMockAgentContext();
    const tool = createMcpAddServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {
      name: 'local',
      transportType: 'stdio',
      command: 'my-mcp-server',
    });

    expect(result.details?.isError).toBeFalsy();
    expect(manager.addServer).toHaveBeenCalled();
    expect(ctx.assignToAgent).toHaveBeenCalledWith('local');
  });

  it('returns error when connection fails', async () => {
    const manager = makeMockManager();
    (manager.addServer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection refused'),
    );
    const store = makeMockStore();
    (store.loadConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = makeMockAgentContext();
    const tool = createMcpAddServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {
      name: 'broken',
      url: 'https://broken.example.com',
      transportType: 'sse',
    });

    expect(result.details?.isError).toBe(true);
    expect(result.content[0].text).toContain('connection refused');
  });
});

describe('mcp_list_servers', () => {
  it('shows assigned and available servers', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const ctx = makeMockAgentContext(['github']);
    const tool = createMcpListServersTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {});
    const text = result.content[0].text;
    expect(text).toContain('Assigned to this agent');
    expect(text).toContain('github');
    expect(text).toContain('connected');
  });

  it('shows empty message when pool is empty', async () => {
    const manager = makeMockManager();
    manager.getTools = vi.fn().mockReturnValue([]);
    const store = makeMockStore();
    (store.loadConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = makeMockAgentContext();
    const tool = createMcpListServersTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {});
    expect(result.content[0].text).toContain('No MCP servers');
  });

  it('shows unassigned servers as available in pool', async () => {
    const manager = makeMockManager();
    const store = makeMockStore(); // has 'github'
    const ctx = makeMockAgentContext([]); // not assigned to this agent
    const tool = createMcpListServersTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', {});
    const text = result.content[0].text;
    expect(text).toContain('Assigned to this agent:** none');
    expect(text).toContain('Available in pool');
    expect(text).toContain('github');
  });
});

describe('mcp_remove_server', () => {
  it('unassigns server from agent', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const ctx = makeMockAgentContext(['github']);
    const tool = createMcpRemoveServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', { name: 'github' });
    expect(result.details?.isError).toBeFalsy();
    expect(ctx.unassignFromAgent).toHaveBeenCalledWith('github');
  });

  it('reports when server was also removed from pool', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const ctx = makeMockAgentContext(['github']);
    (ctx.unassignFromAgent as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const tool = createMcpRemoveServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', { name: 'github' });
    expect(result.content[0].text).toContain('removed from the pool');
  });

  it('reports when server stays in pool for other agents', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const ctx = makeMockAgentContext(['github']);
    (ctx.unassignFromAgent as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const tool = createMcpRemoveServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', { name: 'github' });
    expect(result.content[0].text).toContain('remains in the pool');
  });

  it('returns error for unassigned server', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const ctx = makeMockAgentContext([]); // not assigned
    const tool = createMcpRemoveServerTool({ manager, configStore: store, agentContext: ctx });

    const result = await tool.execute('call-1', { name: 'github' });
    expect(result.details?.isError).toBe(true);
    expect(result.content[0].text).toContain('not assigned to this agent');
  });
});
