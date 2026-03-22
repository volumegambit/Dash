import {
  createMcpAddServerTool,
  createMcpListServersTool,
  createMcpRemoveServerTool,
} from './agent-tools.js';
import type { McpConfigStoreInterface } from './agent-tools.js';
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

describe('mcp_add_server', () => {
  it('connects immediately and returns discovered tools', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const tool = createMcpAddServerTool({ manager, configStore: store });

    const result = await tool.execute('call-1', {
      name: 'jira',
      url: 'https://jira.example.com/mcp',
      transportType: 'sse',
    });

    expect(result.details?.isError).toBeFalsy();
    expect(result.content[0].text).toContain('connected successfully');
    expect(manager.addServer).toHaveBeenCalled();
    expect(store.addConfig).toHaveBeenCalled();
  });

  it('rejects when URL not in allowlist', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    (store.isAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const tool = createMcpAddServerTool({ manager, configStore: store });

    const result = await tool.execute('call-1', {
      name: 'bad',
      url: 'https://evil.com',
      transportType: 'sse',
    });

    expect(result.content[0].text).toContain('not in the allowlist');
    expect(result.details?.isError).toBe(true);
    expect(manager.addServer).not.toHaveBeenCalled();
  });

  it('allows stdio servers without URL check', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const tool = createMcpAddServerTool({ manager, configStore: store });

    const result = await tool.execute('call-1', {
      name: 'local',
      transportType: 'stdio',
      command: 'my-mcp-server',
    });

    expect(result.details?.isError).toBeFalsy();
    expect(manager.addServer).toHaveBeenCalled();
  });

  it('returns error when connection fails', async () => {
    const manager = makeMockManager();
    (manager.addServer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection refused'),
    );
    const store = makeMockStore();
    const tool = createMcpAddServerTool({ manager, configStore: store });

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
  it('returns list of connected servers and tools', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const tool = createMcpListServersTool({ manager, configStore: store });

    const result = await tool.execute('call-1', {});
    const text = result.content[0].text;
    expect(text).toContain('github');
    expect(text).toContain('connected');
  });

  it('returns empty message when no servers', async () => {
    const manager = makeMockManager();
    manager.getTools = vi.fn().mockReturnValue([]);
    const store = makeMockStore();
    (store.loadConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const tool = createMcpListServersTool({ manager, configStore: store });

    const result = await tool.execute('call-1', {});
    expect(result.content[0].text).toContain('No MCP servers');
  });
});

describe('mcp_remove_server', () => {
  it('removes a server', async () => {
    const manager = makeMockManager();
    const store = makeMockStore();
    const tool = createMcpRemoveServerTool({ manager, configStore: store });

    const result = await tool.execute('call-1', { name: 'github' });
    expect(result.details?.isError).toBeFalsy();
    expect(manager.removeServer).toHaveBeenCalledWith('github');
    expect(store.removeConfig).toHaveBeenCalledWith('github');
  });

  it('returns error for unknown server', async () => {
    const manager = makeMockManager();
    (manager.removeServer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'));
    const store = makeMockStore();
    const tool = createMcpRemoveServerTool({ manager, configStore: store });

    const result = await tool.execute('call-1', { name: 'ghost' });
    expect(result.details?.isError).toBe(true);
  });
});
