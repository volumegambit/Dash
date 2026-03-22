import {
  createMcpAddServerTool,
  createMcpConfirmAddTool,
  createMcpListServersTool,
  createMcpRemoveServerTool,
} from './agent-tools.js';
import type { McpConfigStoreInterface } from './agent-tools.js';
import type { McpManager } from './manager.js';
import { McpProposalStore } from './proposals.js';

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
  it('creates a pending proposal and returns confirmation prompt', async () => {
    const proposals = new McpProposalStore();
    const store = makeMockStore();
    const tool = createMcpAddServerTool({ proposalStore: proposals, configStore: store });

    const result = await tool.execute('call-1', {
      name: 'jira',
      url: 'https://jira.example.com/mcp',
      transportType: 'sse',
    });

    expect(result.content[0].text).toContain('jira');
    expect(result.content[0].text).toContain('https://jira.example.com/mcp');
    expect(result.content[0].text).toContain('confirm');
    expect(proposals.get('jira')).toBeDefined();
  });

  it('rejects when URL not in allowlist', async () => {
    const proposals = new McpProposalStore();
    const store = makeMockStore();
    (store.isAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const tool = createMcpAddServerTool({ proposalStore: proposals, configStore: store });

    const result = await tool.execute('call-1', {
      name: 'bad',
      url: 'https://evil.com',
      transportType: 'sse',
    });

    expect(result.content[0].text).toContain('not in the allowlist');
    expect(result.details?.isError).toBe(true);
    expect(proposals.get('bad')).toBeUndefined();
  });

  it('allows stdio servers without URL check', async () => {
    const proposals = new McpProposalStore();
    const store = makeMockStore();
    const tool = createMcpAddServerTool({ proposalStore: proposals, configStore: store });

    const result = await tool.execute('call-1', {
      name: 'local',
      transportType: 'stdio',
      command: 'my-mcp-server',
    });

    expect(result.details?.isError).toBeFalsy();
    expect(proposals.get('local')).toBeDefined();
  });
});

describe('mcp_confirm_add', () => {
  it('connects a pending proposal', async () => {
    const proposals = new McpProposalStore();
    const manager = makeMockManager();
    const store = makeMockStore();

    proposals.add('jira', {
      name: 'jira',
      transport: { type: 'sse', url: 'https://jira.example.com/mcp' },
    });

    const tool = createMcpConfirmAddTool({
      proposalStore: proposals,
      manager,
      configStore: store,
    });

    const result = await tool.execute('call-1', { name: 'jira' });
    expect(result.details?.isError).toBeFalsy();
    expect(manager.addServer).toHaveBeenCalled();
    expect(store.addConfig).toHaveBeenCalled();
    expect(proposals.get('jira')).toBeUndefined(); // consumed
  });

  it('returns error for non-existent proposal', async () => {
    const proposals = new McpProposalStore();
    const manager = makeMockManager();
    const store = makeMockStore();

    const tool = createMcpConfirmAddTool({
      proposalStore: proposals,
      manager,
      configStore: store,
    });

    const result = await tool.execute('call-1', { name: 'ghost' });
    expect(result.details?.isError).toBe(true);
    expect(result.content[0].text).toContain('No pending proposal');
  });

  it('returns error for expired proposal', async () => {
    const proposals = new McpProposalStore(1); // 1ms TTL
    const manager = makeMockManager();
    const store = makeMockStore();

    proposals.add('jira', {
      name: 'jira',
      transport: { type: 'sse', url: 'https://jira.example.com/mcp' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const tool = createMcpConfirmAddTool({
      proposalStore: proposals,
      manager,
      configStore: store,
    });

    const result = await tool.execute('call-1', { name: 'jira' });
    expect(result.details?.isError).toBe(true);
    expect(result.content[0].text).toContain('No pending proposal');
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
