import { beforeEach, describe, expect, it, vi } from 'vitest';

// Track the most-recently-created in-memory AuthStorage so tests can inspect
// set/remove/list calls. Reset in beforeEach via `vi.clearAllMocks()`.
let lastAuthStorage: {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getApiKey: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  _providers: Set<string>;
} | null = null;

vi.mock('@mariozechner/pi-coding-agent', () => ({
  AuthStorage: {
    inMemory: vi.fn(() => {
      const providers = new Set<string>();
      const storage = {
        _providers: providers,
        set: vi.fn((provider: string, _cred: unknown) => {
          providers.add(provider);
        }),
        get: vi.fn(),
        getApiKey: vi.fn(),
        list: vi.fn(() => [...providers]),
        remove: vi.fn((provider: string) => {
          providers.delete(provider);
        }),
      };
      lastAuthStorage = storage;
      return storage;
    }),
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

describe('PiAgentBackend pull-based credential source', () => {
  async function stubSession(): Promise<void> {
    const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
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
  }

  it('accepts a snapshot Record — still works for backwards compatibility', async () => {
    await stubSession();
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      { anthropic: 'sk-snapshot' },
    );
    await backend.start('/tmp/ws');
    expect(lastAuthStorage?._providers).toEqual(new Set(['anthropic']));
    expect(lastAuthStorage?.set).toHaveBeenCalledWith('anthropic', {
      type: 'api_key',
      key: 'sk-snapshot',
    });
  });

  it('calls the provider function at start() time', async () => {
    await stubSession();
    const provider = vi.fn(async () => ({ anthropic: 'sk-from-fn' }));
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      provider,
    );
    await backend.start('/tmp/ws');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(lastAuthStorage?.set).toHaveBeenCalledWith('anthropic', {
      type: 'api_key',
      key: 'sk-from-fn',
    });
  });

  it('picks up a rotated key on the next refreshCredentials() call', async () => {
    // Simulate the real gateway flow: credential store updated out-of-band
    // between two chat messages. The backend must see the new value on the
    // next `run()` without any explicit push.
    await stubSession();
    let current = 'sk-old';
    const provider = vi.fn(async () => ({ anthropic: current }));

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      provider,
    );
    await backend.start('/tmp/ws');
    expect(lastAuthStorage?.set).toHaveBeenLastCalledWith('anthropic', {
      type: 'api_key',
      key: 'sk-old',
    });

    // User rotates the key in the store
    current = 'sk-new';
    await backend.refreshCredentials();

    expect(provider).toHaveBeenCalledTimes(2); // once in start, once in refresh
    expect(lastAuthStorage?.set).toHaveBeenLastCalledWith('anthropic', {
      type: 'api_key',
      key: 'sk-new',
    });
  });

  it('removes a deleted provider from the live auth storage on refresh', async () => {
    // Scenario: user had both Anthropic and OpenAI keys, then deletes OpenAI.
    // The OpenAI entry in AuthStorage must be REMOVED — otherwise it keeps
    // working from in-memory cache even though the store no longer has it.
    await stubSession();
    const keys: Record<string, string> = {
      anthropic: 'sk-ant',
      openai: 'sk-openai',
    };
    const provider = vi.fn(async () => ({ ...keys }));

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      provider,
    );
    await backend.start('/tmp/ws');
    expect(lastAuthStorage?._providers).toEqual(new Set(['anthropic', 'openai']));

    // Delete openai key from the store
    keys.openai = undefined as unknown as string;
    await backend.refreshCredentials();

    expect(lastAuthStorage?.remove).toHaveBeenCalledWith('openai');
    expect(lastAuthStorage?._providers).toEqual(new Set(['anthropic']));
  });

  it('skips auth rebuild when the store has not changed since last apply', async () => {
    // This is critical for OAuth token refresh correctness. pi's AuthStorage
    // can refresh OAuth tokens in-memory between our refreshCredentials()
    // calls. If we overwrote auth on every refresh with the stale store
    // value, we would clobber pi's refreshed token and trigger 401 loops.
    // The skip-when-store-unchanged check uses direct equality (NOT a hash)
    // so there is no collision risk.
    await stubSession();
    const provider = vi.fn(async () => ({ anthropic: 'sk-stable' }));

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      provider,
    );
    await backend.start('/tmp/ws');
    const setCallsAfterStart = lastAuthStorage?.set.mock.calls.length ?? 0;

    // Store value hasn't changed since start() seeded lastAppliedKeys →
    // each refresh should be a no-op (provider is called, but applyKeys isn't)
    await backend.refreshCredentials();
    await backend.refreshCredentials();

    expect(provider).toHaveBeenCalledTimes(3); // start + 2 refreshes
    expect(lastAuthStorage?.set.mock.calls.length).toBe(setCallsAfterStart);
  });

  it('refreshes when the store value differs from last applied (direct equality, no collision risk)', async () => {
    // Two distinct key maps that would collide under a naive delimiter-based
    // hash (sort + join with `=` and `|`): `{a: 'b|c=d'}` vs `{a: 'b', c: 'd'}`.
    // Both serialize to the same string under a naive hash. Our direct
    // equality check correctly distinguishes them.
    await stubSession();
    let current: Record<string, string> = { anthropic: 'sk-|=' };
    const provider = vi.fn(async () => ({ ...current }));

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      provider,
    );
    await backend.start('/tmp/ws');

    const setCallsAfterStart = lastAuthStorage?.set.mock.calls.length ?? 0;

    // Mutate to a genuinely different map that a naive hash might collide with
    current = { anthropic: 'sk-', openai: 'foo' };
    await backend.refreshCredentials();

    // Must have called set() at least once for the new openai provider
    expect(lastAuthStorage?.set.mock.calls.length).toBeGreaterThan(setCallsAfterStart);
  });

  it('refreshCredentials() is a no-op when backend has not been started', async () => {
    // Defensive: if someone calls refresh before start, we should log a
    // warning and skip rather than crash. The session won't exist yet.
    const provider = vi.fn(async () => ({ anthropic: 'sk-ant' }));
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      provider,
    );
    await expect(backend.refreshCredentials()).resolves.not.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });

  it('distinguishes OAuth tokens (sk-ant-oat*) from API keys', async () => {
    await stubSession();
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      { anthropic: 'sk-ant-oat01-abc' },
    );
    await backend.start('/tmp/ws');
    // Verify the credential was stored as type: 'oauth', not 'api_key'
    expect(lastAuthStorage?.set).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ type: 'oauth', access: 'sk-ant-oat01-abc' }),
    );
  });
});

describe('PiAgentBackend.normalizeEvent — error surfacing', () => {
  it('returns error event when message_end has stopReason: error', () => {
    // Regression test: PiAgent reports upstream API errors (e.g. Anthropic
    // 401 auth failures) via `stopReason: 'error'` on the assistant message.
    // Previously these were silently swallowed and the user saw an empty
    // response. Now they must surface as a Dash `error` event so the chat
    // UI's auth-error banner renders.
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      {},
    );
    const result = backend.normalizeEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-opus-4-20250514',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        errorMessage: '401 authentication_error: Invalid authentication credentials',
        timestamp: 0,
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);

    expect(result).toEqual({
      type: 'error',
      error: new Error('401 authentication_error: Invalid authentication credentials'),
    });
  });

  it('falls back to a generic error message when errorMessage is missing', () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: '' },
      {},
    );
    const result = backend.normalizeEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        // no errorMessage
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toEqual({ type: 'error', error: new Error('Model call failed') });
  });
});

describe('PiAgentBackend model fallback chain', () => {
  /**
   * Build a mock session whose `prompt()` method produces a different
   * behavior on each invocation. Each behavior is a function that receives
   * the current subscribe callback and either throws (to simulate a provider
   * failure) or fires events synchronously (to simulate a successful call).
   */
  function makeSequencedSession(
    // biome-ignore lint/suspicious/noExplicitAny: test mock event type
    behaviors: Array<(cb: (event: any) => void) => void | Promise<void>>,
  ) {
    // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
    let currentCb: ((event: any) => void) | null = null;
    let callIndex = 0;

    const session = {
      dispose: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
      subscribe: vi.fn((cb: any) => {
        currentCb = cb;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        const behavior = behaviors[callIndex++];
        if (!behavior) {
          throw new Error(`No behavior for prompt call ${callIndex}`);
        }
        if (!currentCb) {
          throw new Error('subscribe() was not called before prompt()');
        }
        await behavior(currentCb);
      }),
      abort: vi.fn(),
      setModel: vi.fn().mockResolvedValue(undefined),
      getActiveToolNames: vi.fn(() => ['read', 'bash']),
      setActiveToolsByName: vi.fn(),
      agent: { setSystemPrompt: vi.fn() },
    };

    return session;
  }

  /** Fire a minimal successful sequence: single text_delta + message_end + agent_end */
  // biome-ignore lint/suspicious/noExplicitAny: test mock event type
  function fireSuccess(cb: (event: any) => void, text: string) {
    cb({
      type: 'message_update',
      message: {},
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: text,
        partial: {},
      },
    });
    cb({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: {
          input: 5,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    cb({ type: 'agent_end', messages: [] });
  }

  async function mountBackend(session: ReturnType<typeof makeSequencedSession>) {
    const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      session: session as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      {
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'Test',
      },
      { anthropic: 'test-key' },
    );
    await backend.start('/tmp/test');
    return backend;
  }

  /**
   * Build an AgentState. `fallbackModels` lives on the state rather
   * than on the backend's constructor config because PiAgentBackend
   * reads the fallback chain from `state.fallbackModels` on each
   * run() call — this lets `PUT /agents/:id` changes propagate on
   * the next message without evicting the warm pool entry.
   */
  function makeState(fallbackModels?: string[]) {
    return {
      channelId: 'ch-1',
      conversationId: 'conv-1',
      model: 'anthropic/claude-sonnet-4-20250514',
      fallbackModels,
      message: 'hello',
      systemPrompt: 'Test',
    };
  }

  it('primary model succeeds: fallbacks are never invoked', async () => {
    const session = makeSequencedSession([(cb) => fireSuccess(cb, 'primary')]);
    const backend = await mountBackend(session, ['anthropic/claude-haiku-4-20250514']);

    const events: AgentEvent[] = [];
    for await (const ev of backend.run(makeState(), {})) {
      events.push(ev);
    }

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.setModel).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: 'text_delta', text: 'primary' },
      {
        type: 'response',
        content: 'primary',
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    await backend.stop();
  });

  it('primary fails before any output: fallback runs and its output is yielded', async () => {
    const session = makeSequencedSession([
      () => {
        // First attempt: provider error before any events
        throw new Error('rate limit exceeded');
      },
      (cb) => fireSuccess(cb, 'from-fallback'),
    ]);
    const backend = await mountBackend(session);

    const events: AgentEvent[] = [];
    for await (const ev of backend.run(makeState(['anthropic/claude-haiku-4-20250514']), {})) {
      events.push(ev);
    }

    // Prompt called twice (primary + fallback), setModel called twice
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.setModel).toHaveBeenCalledTimes(2);

    // Primary's error is swallowed; caller sees only the fallback's output.
    // No 'error' event in the stream.
    expect(events).toEqual([
      { type: 'text_delta', text: 'from-fallback' },
      {
        type: 'response',
        content: 'from-fallback',
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    await backend.stop();
  });

  it('all models fail: final attempt yields the last error', async () => {
    const session = makeSequencedSession([
      () => {
        throw new Error('primary: rate limit');
      },
      () => {
        throw new Error('fallback-1: provider down');
      },
      () => {
        throw new Error('fallback-2: auth failed');
      },
    ]);
    const backend = await mountBackend(session);

    const events: AgentEvent[] = [];
    for await (const ev of backend.run(
      makeState(['anthropic/claude-haiku-4-20250514', 'openai/gpt-4o']),
      {},
    )) {
      events.push(ev);
    }

    // All three attempts fired
    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(session.setModel).toHaveBeenCalledTimes(3);

    // Caller sees exactly one error event — the final failure
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'error',
      error: new Error('fallback-2: auth failed'),
    });

    await backend.stop();
  });

  it('primary fails AFTER content is emitted: error propagates, no retry', async () => {
    const session = makeSequencedSession([
      (cb) => {
        // Emit one text delta then fail — mid-stream provider error
        cb({
          type: 'message_update',
          message: {},
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'partial',
            partial: {},
          },
        });
        throw new Error('stream died mid-response');
      },
      // This behavior should NEVER run
      (cb) => fireSuccess(cb, 'should-not-appear'),
    ]);
    const backend = await mountBackend(session);

    const events: AgentEvent[] = [];
    for await (const ev of backend.run(makeState(['anthropic/claude-haiku-4-20250514']), {})) {
      events.push(ev);
    }

    // Only the primary was invoked — the fallback was NOT tried because
    // content had already been committed to the stream.
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.setModel).toHaveBeenCalledTimes(1);

    // Caller sees the partial content, then the error
    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'error', error: new Error('stream died mid-response') },
    ]);

    await backend.stop();
  });

  it('no fallbacks configured: behaves exactly like a single-model run', async () => {
    const session = makeSequencedSession([
      () => {
        throw new Error('boom');
      },
    ]);
    // No fallbackModels passed
    const backend = await mountBackend(session);

    const events: AgentEvent[] = [];
    for await (const ev of backend.run(makeState(), {})) {
      events.push(ev);
    }

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'error', error: new Error('boom') }]);

    await backend.stop();
  });
});
