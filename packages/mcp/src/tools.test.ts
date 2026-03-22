import { wrapMcpTool } from './tools.js';

describe('wrapMcpTool', () => {
  const mockCallTool = vi.fn();

  const mcpToolDef = {
    name: 'create_issue',
    description: 'Creates a GitHub issue',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['title'],
    },
  };

  beforeEach(() => {
    mockCallTool.mockReset();
  });

  it('namespaces the tool name with server__tool', () => {
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    expect(tool.name).toBe('github__create_issue');
  });

  it('sets the label to "server: name"', () => {
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    expect(tool.label).toBe('github: create_issue');
  });

  it('passes through description', () => {
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    expect(tool.description).toBe('Creates a GitHub issue');
  });

  it('passes through inputSchema as parameters', () => {
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    expect(tool.parameters).toEqual(mcpToolDef.inputSchema);
  });

  it('calls callTool with original name and params on execute', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Issue #42 created' }],
    });
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    const result = await tool.execute('call-1', { title: 'Bug' });
    expect(mockCallTool).toHaveBeenCalledWith(
      'create_issue',
      { title: 'Bug' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.content).toEqual([{ type: 'text', text: 'Issue #42 created' }]);
  });

  it('returns isError on callTool failure', async () => {
    mockCallTool.mockRejectedValue(new Error('Server unavailable'));
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    const result = await tool.execute('call-1', { title: 'Bug' });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Server unavailable'),
    });
    expect(result.details).toEqual({ isError: true });
  });

  it('passes abort signal to callTool', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    const controller = new AbortController();
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    await tool.execute('call-1', { title: 'Bug' }, controller.signal);
    expect(mockCallTool).toHaveBeenCalledWith(
      'create_issue',
      { title: 'Bug' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns error when external signal is aborted', async () => {
    mockCallTool.mockImplementation(
      (_name: string, _params: Record<string, unknown>, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const controller = new AbortController();
    controller.abort();
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    const result = await tool.execute('call-1', { title: 'Bug' }, controller.signal);
    expect(result.details?.isError).toBe(true);
    expect(result.content[0].text).toContain('aborted');
  });

  it('returns isError when MCP result has isError flag', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Permission denied' }],
      isError: true,
    });
    const tool = wrapMcpTool('github', mcpToolDef, mockCallTool, 60_000);
    const result = await tool.execute('call-1', { title: 'Bug' });
    expect(result.details).toEqual({ isError: true });
  });
});
