import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mariozechner/pi-coding-agent', () => ({
  AuthStorage: {
    inMemory: vi.fn(() => ({
      set: vi.fn(),
      get: vi.fn(),
      getApiKey: vi.fn(),
    })),
  },
  DefaultResourceLoader: vi.fn(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    getSkills: vi.fn(() => ({ skills: [], diagnostics: [] })),
    getSystemPrompt: vi.fn(() => undefined),
    getAppendSystemPrompt: vi.fn(() => []),
    getExtensions: vi.fn(() => ({ extensions: [], runtime: {} })),
    getPrompts: vi.fn(() => ({ prompts: [], diagnostics: [] })),
    getThemes: vi.fn(() => ({ themes: [], diagnostics: [] })),
    getAgentsFiles: vi.fn(() => ({ agentsFiles: [] })),
    getPathMetadata: vi.fn(() => new Map()),
    extendResources: vi.fn(),
  })),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
    continueRecent: vi.fn(() => ({})),
  },
  createAgentSession: vi.fn(),
  createBashTool: vi.fn(() => ({ name: 'bash' })),
  createEditTool: vi.fn(() => ({ name: 'edit' })),
  createFindTool: vi.fn(() => ({ name: 'find' })),
  createGrepTool: vi.fn(() => ({ name: 'grep' })),
  createLsTool: vi.fn(() => ({ name: 'ls' })),
  createReadTool: vi.fn(() => ({ name: 'read' })),
  createWriteTool: vi.fn(() => ({ name: 'write' })),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(() => ({
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    api: 'anthropic-messages',
  })),
}));

import type { AgentEvent } from '../types.js';
import { PiAgentBackend } from './piagent.js';

function makeBackend() {
  return new PiAgentBackend(
    { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'You are helpful.' },
    {},
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PiAgentBackend', () => {
  it('has name "piagent"', () => {
    const backend = makeBackend();
    expect(backend.name).toBe('piagent');
  });

  it('constructor does not throw', () => {
    expect(() => makeBackend()).not.toThrow();
  });

  it('throws when run() called before start()', async () => {
    const backend = makeBackend();
    const gen = backend.run(
      {
        channelId: 'ch-1',
        conversationId: 'conv-1',
        model: 'anthropic/claude-sonnet-4-20250514',
        message: 'hello',
        systemPrompt: '',
      },
      {},
    );
    await expect(gen.next()).rejects.toThrow('PiAgentBackend not started');
  });

  it('stop() succeeds even when not started', async () => {
    const backend = makeBackend();
    await expect(backend.stop()).resolves.not.toThrow();
  });
});

describe('PiAgentBackend.normalizeEvent', () => {
  it('returns text_delta for message_update with text_delta', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'message_update',
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      message: {} as any,
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hello',
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        partial: {} as any,
      },
    });
    expect(result).toEqual({ type: 'text_delta', text: 'Hello' });
  });

  it('returns thinking_delta for message_update with thinking_delta', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'message_update',
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      message: {} as any,
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'Thinking...',
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        partial: {} as any,
      },
    });
    expect(result).toEqual({ type: 'thinking_delta', text: 'Thinking...' });
  });

  it('returns error for message_update with error', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'message_update',
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      message: {} as any,
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'test',
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          usage: {} as any,
          stopReason: 'error',
          errorMessage: 'API key invalid',
          timestamp: 0,
        },
      },
    });
    expect(result).toEqual({ type: 'error', error: new Error('API key invalid') });
  });

  it('returns tool_use_start for tool_execution_start', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({
      type: 'tool_use_start',
      id: 'call-1',
      name: 'bash',
      input: { command: 'ls' },
    });
  });

  it('returns tool_use_delta for tool_execution_update', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'partial' }], details: {} },
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({
      type: 'tool_use_delta',
      partial_json: JSON.stringify({ content: [{ type: 'text', text: 'partial' }], details: {} }),
    });
  });

  it('returns tool_result for tool_execution_end', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'done' }], details: {} },
      isError: false,
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({
      type: 'tool_result',
      id: 'call-1',
      name: 'bash',
      content: 'done',
      isError: false,
    });
  });

  it('returns tool_result with isError for failed tool_execution_end', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'command not found' }], details: {} },
      isError: true,
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({
      type: 'tool_result',
      id: 'call-1',
      name: 'bash',
      content: 'command not found',
      isError: true,
    });
  });

  it('returns response for message_end with usage', () => {
    const backend = makeBackend();
    // Accumulate some text first
    backend.normalizeEvent({
      type: 'message_update',
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      message: {} as any,
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hello world',
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        partial: {} as any,
      },
    });

    const result = backend.normalizeEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 165,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);

    expect(result).toEqual({
      type: 'response',
      content: 'Hello world',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
    });
  });

  it('returns context_compacted for auto_compaction_end', () => {
    const backend = makeBackend();
    // Simulate auto_compaction_start with overflow reason
    // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    backend.normalizeEvent({ type: 'auto_compaction_start', reason: 'overflow' } as any);
    const result = backend.normalizeEvent({
      type: 'auto_compaction_end',
      result: undefined,
      aborted: false,
      willRetry: false,
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({ type: 'context_compacted', overflow: true });
  });

  it('returns context_compacted with overflow=false for threshold reason', () => {
    const backend = makeBackend();
    // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    backend.normalizeEvent({ type: 'auto_compaction_start', reason: 'threshold' } as any);
    const result = backend.normalizeEvent({
      type: 'auto_compaction_end',
      result: undefined,
      aborted: false,
      willRetry: false,
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({ type: 'context_compacted', overflow: false });
  });

  it('returns agent_retry for auto_retry_start', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: 'Rate limit',
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({ type: 'agent_retry', attempt: 2, reason: 'Rate limit' });
  });

  it('returns null for unknown event type', () => {
    const backend = makeBackend();
    // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    const result = backend.normalizeEvent({ type: 'agent_start' } as any);
    expect(result).toBeNull();
  });

  it('returns null for message_update with unrecognized assistantMessageEvent type', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'message_update',
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      message: {} as any,
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '...',
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        partial: {} as any,
      },
    });
    expect(result).toBeNull();
  });
});

describe('PiAgentBackend lifecycle', () => {
  it('start() creates session and stop() disposes it', async () => {
    const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
    const mockDispose = vi.fn();
    const mockSetModel = vi.fn().mockResolvedValue(undefined);
    const mockAgent = { setSystemPrompt: vi.fn() };
    const activeTools = ['read', 'bash', 'edit', 'write'];
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        dispose: mockDispose,
        subscribe: vi.fn(),
        prompt: vi.fn(),
        abort: vi.fn(),
        setModel: mockSetModel,
        agent: mockAgent,
        getActiveToolNames: vi.fn(() => activeTools),
        setActiveToolsByName: vi.fn(),
        // biome-ignore lint/suspicious/noExplicitAny: test mock for partial session object
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: '' },
      { anthropic: 'test-key-123' },
    );

    await backend.start('/tmp/test');
    expect(createAgentSession).toHaveBeenCalled();

    await backend.stop();
    expect(mockDispose).toHaveBeenCalled();
  });

  it('run() yields events from session and completes on agent_end', async () => {
    const { createAgentSession } = await import('@mariozechner/pi-coding-agent');

    // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
    let subscribeCb: ((event: any) => void) | null = null;
    const mockAgent = { setSystemPrompt: vi.fn() };
    const activeTools = ['read', 'bash', 'edit', 'write'];
    const mockSession = {
      dispose: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
      subscribe: vi.fn((cb: any) => {
        subscribeCb = cb;
        return vi.fn(); // unsubscribe
      }),
      prompt: vi.fn(async () => {
        // Simulate events from the agent
        subscribeCb?.({
          type: 'message_update',
          message: {},
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi', partial: {} },
        });
        subscribeCb?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        });
        subscribeCb?.({ type: 'agent_end', messages: [] });
      }),
      abort: vi.fn(),
      setModel: vi.fn().mockResolvedValue(undefined),
      getActiveToolNames: vi.fn(() => activeTools),
      setActiveToolsByName: vi.fn(),
      agent: mockAgent,
    };

    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial session object
      session: mockSession as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'Test' },
      { anthropic: 'test-key' },
    );

    await backend.start('/tmp/test');

    const events: AgentEvent[] = [];
    for await (const ev of backend.run(
      {
        channelId: 'ch-1',
        conversationId: 'conv-1',
        model: 'anthropic/claude-sonnet-4-20250514',
        message: 'hello',
        systemPrompt: 'Test',
      },
      {},
    )) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hi' },
      {
        type: 'response',
        content: 'Hi',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    await backend.stop();
  });
});

describe('PiAgentBackend sessionDir', () => {
  it('accepts optional sessionDir parameter', () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'test' },
      { anthropic: 'sk-test-key' },
      undefined,
      '/tmp/test-session-dir',
    );
    expect(backend).toBeDefined();
    expect(backend.name).toBe('piagent');
  });

  it('uses SessionManager.continueRecent when sessionDir is provided', async () => {
    const { SessionManager, createAgentSession } = await import('@mariozechner/pi-coding-agent');
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        dispose: vi.fn(),
        subscribe: vi.fn(),
        prompt: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn(),
        getActiveToolNames: vi.fn(() => []),
        setActiveToolsByName: vi.fn(),
        agent: { setSystemPrompt: vi.fn() },
        // biome-ignore lint/suspicious/noExplicitAny: test mock for partial session object
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'test' },
      { anthropic: 'sk-test-key' },
      undefined,
      '/tmp/test-session-dir',
    );
    await backend.start('/tmp/workspace');
    expect(SessionManager.continueRecent).toHaveBeenCalledWith(
      '/tmp/workspace',
      '/tmp/test-session-dir',
    );
    expect(SessionManager.inMemory).not.toHaveBeenCalled();
  });

  it('uses SessionManager.inMemory when no sessionDir is provided', async () => {
    const { SessionManager, createAgentSession } = await import('@mariozechner/pi-coding-agent');
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        dispose: vi.fn(),
        subscribe: vi.fn(),
        prompt: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn(),
        getActiveToolNames: vi.fn(() => []),
        setActiveToolsByName: vi.fn(),
        agent: { setSystemPrompt: vi.fn() },
        // biome-ignore lint/suspicious/noExplicitAny: test mock for partial session object
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'test' },
      { anthropic: 'sk-test-key' },
    );
    await backend.start('/tmp/workspace');
    expect(SessionManager.inMemory).toHaveBeenCalled();
    expect(SessionManager.continueRecent).not.toHaveBeenCalled();
  });
});
