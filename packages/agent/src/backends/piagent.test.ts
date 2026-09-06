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

vi.mock('@earendil-works/pi-coding-agent', () => ({
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

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: vi.fn(() => ({
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    api: 'anthropic-messages',
  })),
}));

import type { AgentEvent, DeliveredSteerRecord, SteerContent } from '../types.js';
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('PiAgentBackend', () => {
  it('has name "piagent"', () => {
    const backend = makeBackend();
    expect(backend.name).toBe('piagent');
  });

  it('constructor does not throw', () => {
    expect(() => makeBackend()).not.toThrow();
  });

  it('throws synchronously when run() is called before start()', () => {
    const backend = makeBackend();
    expect(() =>
      backend.run(
        {
          channelId: 'ch-1',
          conversationId: 'conv-1',
          model: 'anthropic/claude-sonnet-4-20250514',
          message: 'hello',
          systemPrompt: '',
        },
        {},
      ),
    ).toThrow('PiAgentBackend not started');
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

  it('returns null for message_end of a user message', () => {
    // pi emits message_end whenever ANY message is committed to the session
    // transcript — including the user's own prompt. Only assistant messages
    // mark a completed model turn; user message_end must not produce a bogus
    // empty response event (which polluted the stream and reset MC's token
    // display to "0 in · 0 out").
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'message_end',
      message: {
        role: 'user',
        content: 'Hello there',
        timestamp: 0,
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toBeNull();
  });

  it('returns null for message_end of a toolResult message', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 0,
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    } as any);
    expect(result).toBeNull();
  });

  it('returns context_compacted for compaction_end', () => {
    const backend = makeBackend();
    // Simulate compaction_start with overflow reason
    // biome-ignore lint/suspicious/noExplicitAny: test mock for partial event object
    backend.normalizeEvent({ type: 'compaction_start', reason: 'overflow' } as any);
    const result = backend.normalizeEvent({
      type: 'compaction_end',
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
    backend.normalizeEvent({ type: 'compaction_start', reason: 'threshold' } as any);
    const result = backend.normalizeEvent({
      type: 'compaction_end',
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
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
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
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');

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

  it('run() keeps streaming across pi auto-retry (agent_end with willRetry: true)', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');

    // Reproduces the "chat dies at Request timed out." bug: pi persists the
    // failed assistant message, emits agent_end with willRetry: true, then
    // auto-retries and finishes the turn. The backend must NOT treat the
    // mid-retry agent_end as end-of-turn — the retry's events belong to the
    // same run() stream.
    // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
    let subscribeCb: ((event: any) => void) | null = null;
    const mockAgent = { setSystemPrompt: vi.fn() };
    const mockSession = {
      dispose: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
      subscribe: vi.fn((cb: any) => {
        subscribeCb = cb;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        // Attempt 1: transient provider failure
        subscribeCb?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'Request timed out.',
          },
        });
        // pi emits agent_end BETWEEN attempts, flagged willRetry
        subscribeCb?.({ type: 'agent_end', messages: [], willRetry: true });
        subscribeCb?.({
          type: 'auto_retry_start',
          attempt: 1,
          maxAttempts: 5,
          delayMs: 0,
          errorMessage: 'Request timed out.',
        });
        // Backoff, then the retry succeeds
        await new Promise((r) => setTimeout(r, 5));
        subscribeCb?.({
          type: 'message_update',
          message: {},
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'Recovered',
            partial: {},
          },
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
        subscribeCb?.({ type: 'agent_end', messages: [], willRetry: false });
      }),
      abort: vi.fn(),
      setModel: vi.fn().mockResolvedValue(undefined),
      getActiveToolNames: vi.fn(() => ['read']),
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
      { type: 'error', error: new Error('Request timed out.') },
      { type: 'agent_retry', attempt: 1, reason: 'Request timed out.' },
      { type: 'text_delta', text: 'Recovered' },
      {
        type: 'response',
        content: 'Recovered',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);

    await backend.stop();
  });
});

describe('PiAgentBackend ordered steering', () => {
  const RUN_ID = 'run-1';
  const INPUT_ID = 'input-1';

  type TaggedMessage = {
    role: 'user';
    content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    timestamp: number;
    __dashInputId?: string;
  };

  type CoreHarnessEvent = {
    type: string;
    message?: {
      role: string;
      content: unknown;
      timestamp: number;
      __dashInputId?: string;
    };
    assistantMessageEvent?: unknown;
    messages?: unknown[];
  };

  function makeSteeringHarness(
    options: {
      pauseBeforeEnd?: boolean;
      runtimeMessages?: TaggedMessage[];
      branchMessages?: TaggedMessage[];
      appendFailures?: number;
    } = {},
  ) {
    const providerStarted = deferred<void>();
    const finishFirstTurn = deferred<void>();
    const secondCall = deferred<void>();
    const finalPoll = deferred<void>();
    const allowEnd = deferred<void>();
    const steeringQueue: TaggedMessage[] = [];
    const steered: TaggedMessage[] = [];
    const providerBodies: unknown[] = [];
    const sessionListeners = new Set<(event: unknown) => void>();
    const coreListeners: Array<
      (event: CoreHarnessEvent, signal: AbortSignal) => void | Promise<void>
    > = [];
    const runtimeMessages = [...(options.runtimeMessages ?? [])];
    const branchEntries = (options.branchMessages ?? []).map((message, index) => ({
      type: 'message',
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: new Date(index).toISOString(),
      message,
    }));
    let appendFailures = options.appendFailures ?? 0;
    let aborted = false;

    const sessionManager = {
      getBranch: vi.fn(() => [...branchEntries]),
      appendMessage: vi.fn((message: TaggedMessage) => {
        const entry = {
          type: 'message',
          id: `entry-${branchEntries.length}`,
          parentId: branchEntries.length === 0 ? null : branchEntries[branchEntries.length - 1].id,
          timestamp: new Date().toISOString(),
          message,
        };
        // SessionManager mutates its in-memory tree before attempting the JSONL write.
        branchEntries.push(entry);
        if (appendFailures > 0) {
          appendFailures--;
          throw new Error('disk unavailable');
        }
        return entry.id;
      }),
      _persist: vi.fn(),
    };

    const emitCore = async (event: CoreHarnessEvent) => {
      for (const listener of [...coreListeners]) {
        await listener(event, new AbortController().signal);
      }
    };

    // Model the AgentSession listener that is already registered with Pi core before
    // PiAgentBackend installs its direct per-run boundary listener.
    coreListeners.push(async (event) => {
      for (const listener of [...sessionListeners]) listener(event);
      if (
        event.type === 'message_end' &&
        ['user', 'assistant', 'toolResult'].includes(event.message?.role)
      ) {
        sessionManager.appendMessage(event.message as TaggedMessage);
      }
    });

    const usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const emitAssistant = async (text: string) => {
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage,
        timestamp: Date.now(),
      };
      runtimeMessages.push(message as unknown as TaggedMessage);
      await emitCore({ type: 'message_start', message });
      await emitCore({
        type: 'message_update',
        message,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: message,
        },
      });
      await emitCore({ type: 'message_end', message });
    };

    const agent = {
      steeringMode: 'all',
      state: { messages: runtimeMessages },
      convertToLlm: vi.fn(async (messages: unknown[]) => messages),
      subscribe: vi.fn(
        (listener: (event: CoreHarnessEvent, signal: AbortSignal) => void | Promise<void>) => {
          coreListeners.push(listener);
          return vi.fn(() => {
            const index = coreListeners.indexOf(listener);
            if (index >= 0) coreListeners.splice(index, 1);
          });
        },
      ),
      steer: vi.fn((message: TaggedMessage) => {
        steered.push(message);
        steeringQueue.push(message);
      }),
      clearAllQueues: vi.fn(() => {
        steeringQueue.splice(0);
      }),
      abort: vi.fn(() => {
        aborted = true;
        allowEnd.resolve();
      }),
    };

    const session = {
      sessionManager,
      agent,
      dispose: vi.fn(),
      steer: vi.fn(async () => {}),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        sessionListeners.add(listener);
        return vi.fn(() => sessionListeners.delete(listener));
      }),
      prompt: vi.fn(async (text: string, promptOptions?: { images?: unknown[] }) => {
        const initial = {
          role: 'user' as const,
          content: [
            { type: 'text', text },
            ...(promptOptions?.images ?? []),
          ] as TaggedMessage['content'],
          timestamp: Date.now(),
        };
        runtimeMessages.push(initial);
        await emitCore({ type: 'message_start', message: initial });
        await emitCore({ type: 'message_end', message: initial });
        providerBodies.push(await agent.convertToLlm(runtimeMessages));
        providerStarted.resolve();
        await finishFirstTurn.promise;
        if (!aborted) await emitAssistant('before');

        while (!aborted && steeringQueue.length > 0) {
          const message = steeringQueue.shift() as TaggedMessage;
          runtimeMessages.push(message);
          await emitCore({ type: 'message_start', message });
          await emitCore({ type: 'message_end', message });
          providerBodies.push(await agent.convertToLlm(runtimeMessages));
          secondCall.resolve();
          await emitAssistant('after');
        }

        finalPoll.resolve();
        if (options.pauseBeforeEnd) await allowEnd.promise;
        await emitCore({ type: 'agent_end', messages: [...runtimeMessages] });
      }),
      abort: vi.fn(async () => agent.abort()),
      setModel: vi.fn().mockResolvedValue(undefined),
      getActiveToolNames: vi.fn(() => ['read']),
      setActiveToolsByName: vi.fn(),
    };

    return {
      session,
      agent,
      sessionManager,
      providerStarted,
      finishFirstTurn,
      secondCall,
      finalPoll,
      allowEnd,
      providerBodies,
      steered,
      get runtimeMessages() {
        return agent.state.messages as TaggedMessage[];
      },
      branchEntries,
    };
  }

  async function mountSteeringBackend(
    harness: ReturnType<typeof makeSteeringHarness>,
    backend = makeBackend(),
  ) {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: focused partial AgentSession test double
      session: harness.session as any,
      // biome-ignore lint/suspicious/noExplicitAny: focused partial creation result
      extensionsResult: {} as any,
    });
    await backend.start('/tmp/test');
    return backend;
  }

  function state(conversationId = 'conv-1') {
    return {
      channelId: 'web',
      conversationId,
      model: 'anthropic/claude-sonnet-4-20250514',
      message: 'start',
      systemPrompt: 'Test',
    };
  }

  it('signals backend readiness after typed admission and before provider work', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    let admission: Awaited<ReturnType<PiAgentBackend['steer']>> | undefined;
    const onRunReadyForSteering = vi.fn(async () => {
      admission = await backend.steer(RUN_ID, INPUT_ID, { text: 'admitted' });
      return 'continue' as const;
    });
    const eventsPromise = collectEvents(
      backend.run(state(), {
        runId: RUN_ID,
        onSteerConsumed: async () => {},
        onRunReadyForSteering,
      }),
    );

    await harness.providerStarted.promise;
    const readyBeforeProviderWait = onRunReadyForSteering.mock.calls.length;
    backend.abort();
    harness.finishFirstTurn.resolve();
    await eventsPromise;
    await backend.sealSteering(RUN_ID);

    expect(readyBeforeProviderWait).toBe(1);
    expect(admission).toEqual({ accepted: true });
  });

  it('holds the provider behind an ordered durable Steer boundary', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const deliveryGate = deferred<void>();
    const callbackStarted = deferred<void>();
    const committed: string[] = [];
    const eventsPromise = collectEvents(
      backend.run(state(), {
        runId: RUN_ID,
        onSteerConsumed: async (inputId) => {
          committed.push(inputId);
          callbackStarted.resolve();
          await deliveryGate.promise;
        },
      }),
    );

    await harness.providerStarted.promise;
    await expect(backend.steer(RUN_ID, INPUT_ID, { text: 'focus' })).resolves.toEqual({
      accepted: true,
    });
    harness.finishFirstTurn.resolve();
    await callbackStarted.promise;
    expect(harness.providerBodies).toHaveLength(1);
    expect(harness.branchEntries.some((entry) => entry.message.__dashInputId === INPUT_ID)).toBe(
      false,
    );
    deliveryGate.resolve();
    await harness.secondCall.promise;
    expect(committed).toEqual([INPUT_ID]);
    expect(harness.branchEntries.some((entry) => entry.message.__dashInputId === INPUT_ID)).toBe(
      true,
    );

    const events = await eventsPromise;
    expect(events).toEqual([
      { type: 'text_delta', text: 'before' },
      expect.objectContaining({ type: 'response', content: 'before' }),
      { type: 'text_delta', text: 'after' },
      expect.objectContaining({ type: 'response', content: 'after' }),
    ]);
  });

  it('correlates identical Steers by opaque ID without leaking metadata to providers or events', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const consumed: string[] = [];
    const eventsPromise = collectEvents(
      backend.run(state(), {
        runId: RUN_ID,
        onSteerConsumed: async (inputId) => {
          consumed.push(inputId);
        },
      }),
    );

    await harness.providerStarted.promise;
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'aGVsbG8=' };
    await backend.steer(RUN_ID, 'opaque-a', { text: 'same', images: [image] });
    await backend.steer(RUN_ID, 'opaque-b', { text: 'same' });
    harness.finishFirstTurn.resolve();
    const events = await eventsPromise;

    expect(consumed).toEqual(['opaque-a', 'opaque-b']);
    expect(harness.steered[0]).toMatchObject({
      role: 'user',
      __dashInputId: 'opaque-a',
      content: [
        { type: 'text', text: 'same' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
    });
    expect(JSON.stringify(harness.providerBodies)).not.toContain('__dashInputId');
    expect(JSON.stringify(events)).not.toContain('__dashInputId');
    expect(
      events.filter((event) => event.type === 'response').map((event) => event.content),
    ).toEqual(['before', 'after', 'after']);
  });

  it('rejects idle, wrong-run, and runId-only steering without queueing', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    await expect(backend.steer(RUN_ID, INPUT_ID, { text: 'idle' })).resolves.toEqual({
      accepted: false,
      reason: 'idle',
    });

    const eventsPromise = collectEvents(backend.run(state(), { runId: RUN_ID }));
    await harness.providerStarted.promise;
    await expect(backend.steer('wrong-run', INPUT_ID, { text: 'wrong' })).resolves.toEqual({
      accepted: false,
      reason: 'run_mismatch',
    });
    await expect(backend.steer(RUN_ID, INPUT_ID, { text: 'sealed' })).resolves.toEqual({
      accepted: false,
      reason: 'sealed',
    });
    expect(harness.agent.steer).not.toHaveBeenCalled();
    harness.finishFirstTurn.resolve();
    await eventsPromise;
  });

  it('aborts before a second provider call when durable delivery fails', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const eventsPromise = collectEvents(
      backend.run(state(), {
        runId: RUN_ID,
        onSteerConsumed: async () => {
          throw new Error('sqlite failed');
        },
      }),
    );
    await harness.providerStarted.promise;
    await backend.steer(RUN_ID, INPUT_ID, { text: 'focus' });
    harness.finishFirstTurn.resolve();
    const events = await eventsPromise;

    expect(harness.providerBodies).toHaveLength(1);
    expect(harness.agent.clearAllQueues).toHaveBeenCalled();
    expect(harness.agent.abort).toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'error', error: new Error('sqlite failed') });
  });

  it('rejects an awaited boundary on abort without deadlocking the generator', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const callbackStarted = deferred<void>();
    const never = deferred<void>();
    const eventsPromise = collectEvents(
      backend.run(state(), {
        runId: RUN_ID,
        onSteerConsumed: async () => {
          callbackStarted.resolve();
          await never.promise;
        },
      }),
    );
    await harness.providerStarted.promise;
    await backend.steer(RUN_ID, INPUT_ID, { text: 'focus' });
    harness.finishFirstTurn.resolve();
    await callbackStarted.promise;
    backend.abort();

    const result = await Promise.race([
      eventsPromise.then((events) => ({ settled: true, events })),
      new Promise<{ settled: false }>((resolve) =>
        setTimeout(() => resolve({ settled: false }), 100),
      ),
    ]);
    expect(result.settled).toBe(true);
    expect(harness.providerBodies).toHaveLength(1);
    expect(harness.agent.abort).toHaveBeenCalled();
  });

  it('retains ended-unsealed state and returns an idempotent cached seal snapshot', async () => {
    const harness = makeSteeringHarness({ pauseBeforeEnd: true });
    const backend = await mountSteeringBackend(harness);
    const eventsPromise = collectEvents(
      backend.run(state(), { runId: RUN_ID, onSteerConsumed: async () => {} }),
    );
    await harness.providerStarted.promise;
    harness.finishFirstTurn.resolve();
    await harness.finalPoll.promise;
    await backend.steer(RUN_ID, INPUT_ID, { text: 'too late for final poll' });
    harness.allowEnd.resolve();
    await eventsPromise;

    await expect(backend.steer(RUN_ID, 'post-end', { text: 'late' })).resolves.toEqual({
      accepted: false,
      reason: 'sealed',
    });
    await expect(backend.sealSteering(RUN_ID)).resolves.toEqual([INPUT_ID]);
    await expect(backend.sealSteering(RUN_ID)).resolves.toEqual([INPUT_ID]);
    expect(harness.agent.clearAllQueues).toHaveBeenCalledTimes(1);
    expect(harness.agent.abort).toHaveBeenCalledTimes(1);
  });

  it('does not let a new run overwrite an ended-unsealed predecessor', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const first = collectEvents(
      backend.run(state(), { runId: RUN_ID, onSteerConsumed: async () => {} }),
    );
    await harness.providerStarted.promise;
    harness.finishFirstTurn.resolve();
    await first;

    expect(() =>
      backend.run(state('conv-2'), {
        runId: 'run-2',
        onSteerConsumed: async () => {},
      }),
    ).toThrow(/unsealed/);
  });

  it('claims run ownership synchronously before the first iterator pull', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const first = backend.run(state(), {
      runId: RUN_ID,
      onSteerConsumed: async () => {},
    });

    expect(() =>
      backend.run(state('conv-2'), {
        runId: 'run-2',
        onSteerConsumed: async () => {},
      }),
    ).toThrow(/in progress/);
    expect(() => backend.run(state('conv-legacy'), {})).toThrow(/in progress/);

    await first.return(undefined as never);
    const replacement = backend.run(state('conv-2'), {
      runId: 'run-2',
      onSteerConsumed: async () => {},
    });
    await replacement.return(undefined as never);
  });

  it('keeps run ownership through early seal and asynchronous unwind', async () => {
    const harness = makeSteeringHarness();
    const stopStarted = deferred<void>();
    const finishStop = deferred<void>();
    const hookRunner = {
      runPreToolUse: vi.fn().mockResolvedValue({ block: false }),
      runPostToolUse: vi.fn().mockResolvedValue({ block: false }),
      runSessionStart: vi.fn().mockResolvedValue({}),
      runStop: vi.fn(async () => {
        stopStarted.resolve();
        await finishStop.promise;
        return {};
      }),
      hasHooks: true,
    };
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'You are helpful.' },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [],
      hookRunner,
    );
    await mountSteeringBackend(harness, backend);
    const first = collectEvents(
      backend.run(state(), { runId: RUN_ID, onSteerConsumed: async () => {} }),
    );
    await harness.providerStarted.promise;
    await backend.sealSteering(RUN_ID);
    harness.finishFirstTurn.resolve();
    await stopStarted.promise;

    expect(() =>
      backend.run(state('conv-2'), {
        runId: 'run-2',
        onSteerConsumed: async () => {},
      }),
    ).toThrow(/in progress/);
    expect(() => backend.run(state('conv-legacy'), {})).toThrow(/in progress/);

    finishStop.resolve();
    await first;
    const replacement = backend.run(state('conv-2'), {
      runId: 'run-2',
      onSteerConsumed: async () => {},
    });
    await replacement.return(undefined as never);
  });

  it('reconciles runtime and full branch independently in canonical order', async () => {
    const runtimeOnly = {
      role: 'user' as const,
      content: 'runtime',
      timestamp: 1,
      __dashInputId: 'runtime-only',
    };
    const branchOnly = {
      role: 'user' as const,
      content: 'branch',
      timestamp: 2,
      __dashInputId: 'branch-only',
    };
    const undelivered = {
      role: 'user' as const,
      content: 'drop',
      timestamp: 3,
      __dashInputId: 'not-delivered',
    };
    const harness = makeSteeringHarness({
      runtimeMessages: [runtimeOnly, undelivered],
      branchMessages: [branchOnly],
    });
    const backend = await mountSteeringBackend(harness);
    const records: DeliveredSteerRecord[] = [
      { inputId: 'runtime-only', content: { text: 'runtime' } },
      { inputId: 'branch-only', content: { text: 'branch' } },
    ];

    await backend.reconcileSteers(records);
    await backend.reconcileSteers(records);

    expect(
      harness.runtimeMessages
        .filter((message) => message.__dashInputId)
        .map((message) => message.__dashInputId),
    ).toEqual(['runtime-only', 'branch-only']);
    expect(
      harness.branchEntries
        .map((entry) => entry.message.__dashInputId)
        .filter((id): id is string => Boolean(id)),
    ).toEqual(['branch-only', 'runtime-only']);
    expect(harness.sessionManager.appendMessage).toHaveBeenCalledTimes(1);
  });

  it('retries persistence after appendMessage mutates manager memory and throws', async () => {
    const harness = makeSteeringHarness({ appendFailures: 1 });
    const backend = await mountSteeringBackend(harness);
    const records: DeliveredSteerRecord[] = [{ inputId: INPUT_ID, content: { text: 'committed' } }];

    await expect(backend.reconcileSteers(records)).rejects.toThrow('disk unavailable');
    await expect(backend.reconcileSteers(records)).resolves.toBeUndefined();

    expect(harness.sessionManager.appendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sessionManager._persist).toHaveBeenCalledTimes(1);
    expect(
      harness.runtimeMessages.filter((message) => message.__dashInputId === INPUT_ID),
    ).toHaveLength(1);
  });

  it('reasserts one-at-a-time mode and cleans listeners across start-stop-start', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    expect(harness.agent.steeringMode).toBe('one-at-a-time');
    harness.agent.steeringMode = 'all';
    const eventsPromise = collectEvents(
      backend.run(state(), { runId: RUN_ID, onSteerConsumed: vi.fn() }),
    );
    await harness.providerStarted.promise;
    expect(harness.agent.steeringMode).toBe('one-at-a-time');
    harness.finishFirstTurn.resolve();
    await eventsPromise;
    await backend.stop();
    expect(harness.agent.subscribe).toHaveBeenCalledTimes(1);
    expect(harness.session.dispose).toHaveBeenCalled();

    const restarted = makeSteeringHarness();
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: focused partial AgentSession test double
      session: restarted.session as any,
      // biome-ignore lint/suspicious/noExplicitAny: focused partial creation result
      extensionsResult: {} as any,
    });
    await backend.start('/tmp/test');
    const restartedEvents = collectEvents(
      backend.run(state(), { runId: 'run-restarted', onSteerConsumed: vi.fn() }),
    );
    await restarted.providerStarted.promise;
    expect(restarted.agent.steeringMode).toBe('one-at-a-time');
    restarted.finishFirstTurn.resolve();
    await restartedEvents;
    await backend.stop();
    expect(restarted.agent.subscribe).toHaveBeenCalledTimes(1);
    expect(restarted.session.dispose).toHaveBeenCalled();
  });

  it('constructs Steer content with explicit MIME mapping and stable block order', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const eventsPromise = collectEvents(
      backend.run(state(), { runId: RUN_ID, onSteerConsumed: async () => {} }),
    );
    await harness.providerStarted.promise;
    const content: SteerContent = {
      text: 'look',
      images: [
        { type: 'image', mediaType: 'image/jpeg', data: 'one' },
        { type: 'image', mediaType: 'image/webp', data: 'two' },
      ],
    };
    await backend.steer(RUN_ID, INPUT_ID, content);
    expect(harness.steered[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/jpeg', data: 'one' },
      { type: 'image', mimeType: 'image/webp', data: 'two' },
    ]);
    backend.abort();
    harness.finishFirstTurn.resolve();
    await eventsPromise;
  });

  it('keeps legacy session steering separate from typed correlated steering', async () => {
    const harness = makeSteeringHarness();
    const backend = await mountSteeringBackend(harness);
    const images = [{ type: 'image' as const, mediaType: 'image/webp' as const, data: 'd2VicA==' }];

    await backend.steerLegacy('legacy text', images);

    expect(harness.session.steer).toHaveBeenCalledWith('legacy text', [
      { type: 'image', mimeType: 'image/webp', data: 'd2VicA==' },
    ]);
    expect(harness.agent.steer).not.toHaveBeenCalled();
    expect(typeof backend.steer).toBe('function');
  });
});

describe('PiAgentBackend plugin hooks', () => {
  // Build a mocked session whose prompt() emits a single message_end + agent_end
  // so run() completes promptly. Records the agent object so we can assert the
  // tool-hook composition wired our wrappers onto it.
  function makeMockSession() {
    // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
    let subscribeCb: ((event: any) => void) | null = null;
    const mockAgent: {
      // biome-ignore lint/suspicious/noExplicitAny: fake pi Agent hook fields
      beforeToolCall?: (ctx: any, signal?: AbortSignal) => Promise<any>;
      // biome-ignore lint/suspicious/noExplicitAny: fake pi Agent hook fields
      afterToolCall?: (ctx: any, signal?: AbortSignal) => Promise<any>;
    } = {};
    const activeTools = ['read', 'bash', 'edit', 'write'];
    const mockSession = {
      dispose: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
      subscribe: vi.fn((cb: any) => {
        subscribeCb = cb;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        subscribeCb?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
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
    return { mockSession, mockAgent };
  }

  function makeHookRunner(hasHooks: boolean) {
    return {
      runPreToolUse: vi.fn().mockResolvedValue({ block: false }),
      runPostToolUse: vi.fn().mockResolvedValue({ block: false }),
      runUserPromptSubmit: vi.fn().mockResolvedValue({ block: false }),
      runSessionStart: vi.fn().mockResolvedValue({}),
      runStop: vi.fn().mockResolvedValue({}),
      hasHooks,
    };
  }

  async function runOnce(backend: PiAgentBackend) {
    await backend.start('/tmp/test');
    for await (const _ev of backend.run(
      {
        channelId: 'ch-1',
        conversationId: 'conv-1',
        model: 'anthropic/claude-sonnet-4-20250514',
        message: 'hello',
        systemPrompt: 'Test',
      },
      {},
    )) {
      // drain
    }
  }

  it('fires SessionStart and Stop once per run when hooks are present', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const { mockSession } = makeMockSession();
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      session: mockSession as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const hookRunner = makeHookRunner(true);
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'Test' },
      { anthropic: 'test-key' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [],
      // biome-ignore lint/suspicious/noExplicitAny: structural HookRunner stub
      hookRunner as any,
    );

    await runOnce(backend);

    expect(hookRunner.runSessionStart).toHaveBeenCalledTimes(1);
    expect(hookRunner.runSessionStart).toHaveBeenCalledWith({
      sessionId: 'conv-1',
      cwd: '/tmp/test',
      source: 'startup',
    });
    expect(hookRunner.runStop).toHaveBeenCalledTimes(1);
    expect(hookRunner.runStop).toHaveBeenCalledWith({ sessionId: 'conv-1', cwd: '/tmp/test' });

    await backend.stop();
  });

  it("fires SessionStart with source 'resume' for a persisted (sessionDir) session", async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const { mockSession } = makeMockSession();
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      session: mockSession as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const hookRunner = makeHookRunner(true);
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'Test' },
      { anthropic: 'test-key' },
      undefined,
      '/tmp/sessions', // sessionDir set → SessionManager.continueRecent → resume
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [],
      // biome-ignore lint/suspicious/noExplicitAny: structural HookRunner stub
      hookRunner as any,
    );

    await runOnce(backend);

    expect(hookRunner.runSessionStart).toHaveBeenCalledWith({
      sessionId: 'conv-1',
      cwd: '/tmp/test',
      source: 'resume',
    });

    await backend.stop();
  });

  it('composes tool hooks onto the pi agent when hooks are present', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const { mockSession, mockAgent } = makeMockSession();
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      session: mockSession as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const hookRunner = makeHookRunner(true);
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'Test' },
      { anthropic: 'test-key' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [],
      // biome-ignore lint/suspicious/noExplicitAny: structural HookRunner stub
      hookRunner as any,
    );

    await backend.start('/tmp/test');

    // composeToolHooks installed our wrappers onto the agent's mutable fields.
    expect(typeof mockAgent.beforeToolCall).toBe('function');
    expect(typeof mockAgent.afterToolCall).toBe('function');

    await backend.stop();
  });

  it('does not wire hooks or fire lifecycle when hookRunner is absent', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const { mockSession, mockAgent } = makeMockSession();
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      session: mockSession as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'Test' },
      { anthropic: 'test-key' },
    );

    await runOnce(backend);

    // No composition occurred — the agent's hook fields remain untouched.
    expect(mockAgent.beforeToolCall).toBeUndefined();
    expect(mockAgent.afterToolCall).toBeUndefined();

    await backend.stop();
  });

  it('skips lifecycle hooks and tool-hook composition when hasHooks is false', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const { mockSession, mockAgent } = makeMockSession();
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      session: mockSession as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const hookRunner = makeHookRunner(false);
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'Test' },
      { anthropic: 'test-key' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [],
      // biome-ignore lint/suspicious/noExplicitAny: structural HookRunner stub
      hookRunner as any,
    );

    await runOnce(backend);

    expect(hookRunner.runSessionStart).not.toHaveBeenCalled();
    expect(hookRunner.runStop).not.toHaveBeenCalled();
    // Composition was skipped — the agent's hook fields remain untouched.
    expect(mockAgent.beforeToolCall).toBeUndefined();
    expect(mockAgent.afterToolCall).toBeUndefined();

    await backend.stop();
  });
});

describe('PiAgentBackend SessionStart additionalContext per-run isolation', () => {
  // A mock session whose prompt() snapshots the resource loader's effective
  // append-system-prompt at fire-time, so each run's contribution can be
  // asserted independently. Records one snapshot per prompt() call.
  function makeSnapshotSession(getAppend: () => string[]) {
    // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
    let subscribeCb: ((event: any) => void) | null = null;
    const appendSnapshots: string[][] = [];
    const mockSession = {
      dispose: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock callback type
      subscribe: vi.fn((cb: any) => {
        subscribeCb = cb;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        appendSnapshots.push([...getAppend()]);
        subscribeCb?.({
          type: 'message_end',
          message: { role: 'assistant', usage: { input: 1, output: 1 } },
        });
        subscribeCb?.({ type: 'agent_end', messages: [] });
      }),
      abort: vi.fn(),
      setModel: vi.fn().mockResolvedValue(undefined),
      getActiveToolNames: vi.fn(() => ['read']),
      setActiveToolsByName: vi.fn(),
      agent: {},
    };
    return { mockSession, appendSnapshots };
  }

  it("does not leak run N's SessionStart additionalContext into run N+1 (run 2 returns none)", async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');

    // Build the backend first so we can read its (real) DashResourceLoader for
    // the snapshot. The mocked DefaultResourceLoader contributes an empty base.
    const hookRunner = {
      runPreToolUse: vi.fn().mockResolvedValue({ block: false }),
      runPostToolUse: vi.fn().mockResolvedValue({ block: false }),
      runSessionStart: vi
        .fn()
        .mockResolvedValueOnce({ additionalContext: 'CTX1' })
        .mockResolvedValueOnce({}),
      runStop: vi.fn().mockResolvedValue({}),
      hasHooks: true,
    };
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'Test' },
      { anthropic: 'test-key' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [],
      // biome-ignore lint/suspicious/noExplicitAny: structural HookRunner stub
      hookRunner as any,
    );

    const { mockSession, appendSnapshots } = makeSnapshotSession(
      () =>
        // biome-ignore lint/suspicious/noExplicitAny: read real DashResourceLoader from private field
        ((backend as any).resourceLoader?.getAppendSystemPrompt() as string[]) ?? [],
    );
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      session: mockSession as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    await backend.start('/tmp/test');

    const runState = {
      channelId: 'ch-1',
      conversationId: 'conv-1',
      model: 'anthropic/claude-sonnet-4-20250514',
      message: 'hello',
      systemPrompt: 'Test',
    };

    // Run 1: SessionStart returns CTX1.
    for await (const _ of backend.run(runState, {})) {
      // drain
    }
    // Run 2: SessionStart returns nothing.
    for await (const _ of backend.run(runState, {})) {
      // drain
    }

    expect(appendSnapshots).toHaveLength(2);
    // Run 1 saw CTX1.
    expect(appendSnapshots[0]).toContain('CTX1');
    // Run 2 must NOT inherit CTX1 — the per-run contribution is reset.
    expect(appendSnapshots[1]).not.toContain('CTX1');

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
    const { SessionManager, createAgentSession } = await import('@earendil-works/pi-coding-agent');
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
    const { SessionManager, createAgentSession } = await import('@earendil-works/pi-coding-agent');
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
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
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

  async function mountBackend(
    session: ReturnType<typeof makeSequencedSession>,
    _fallbackModels?: string[],
  ) {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
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

describe('PiAgentBackend skill tool registration', () => {
  it('registers install_skill and remove_skill when allow-listed with a managed dir', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const setActiveToolsByName = vi.fn();
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        dispose: vi.fn(),
        subscribe: vi.fn(),
        prompt: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        agent: { setSystemPrompt: vi.fn() },
        getActiveToolNames: vi.fn(() => []),
        setActiveToolsByName,
        // biome-ignore lint/suspicious/noExplicitAny: test mock for partial session object
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      {
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: '',
        tools: ['install_skill', 'remove_skill'],
      },
      { anthropic: 'k' },
      undefined,
      undefined,
      '/tmp/dash-managed-skills',
    );
    await backend.start('/tmp/test');

    const activated = setActiveToolsByName.mock.calls[0]?.[0] as string[];
    expect(activated).toContain('install_skill');
    expect(activated).toContain('remove_skill');
  });

  it('omits install_skill/remove_skill when they are not allow-listed', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    const setActiveToolsByName = vi.fn();
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        dispose: vi.fn(),
        subscribe: vi.fn(),
        prompt: vi.fn(),
        abort: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        agent: { setSystemPrompt: vi.fn() },
        getActiveToolNames: vi.fn(() => []),
        setActiveToolsByName,
        // biome-ignore lint/suspicious/noExplicitAny: test mock for partial session object
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      extensionsResult: {} as any,
    });

    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: '', tools: ['read'] },
      { anthropic: 'k' },
      undefined,
      undefined,
      '/tmp/dash-managed-skills',
    );
    await backend.start('/tmp/test');

    const activated = setActiveToolsByName.mock.calls[0]?.[0] as string[];
    expect(activated).not.toContain('install_skill');
    expect(activated).not.toContain('remove_skill');
  });
});

describe('PiAgentBackend memory tools registration', () => {
  function memoryBackend(memory?: { dir: string; tools?: boolean }) {
    return new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'p', memory },
      {},
    );
  }

  it('registers the memory tools when config.memory.dir is set', () => {
    const backend = memoryBackend({ dir: '/tmp/dash-mem-test' });
    // biome-ignore lint/suspicious/noExplicitAny: buildCustomTools is private
    const names = (backend as any).buildCustomTools().map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['save_memory', 'recall_memory', 'forget_memory']),
    );
  });

  it('registers them even when config.tools omits them (always-on, not allowlisted)', () => {
    const backend = new PiAgentBackend(
      {
        model: 'anthropic/claude-sonnet-4-20250514',
        systemPrompt: 'p',
        tools: ['read'],
        memory: { dir: '/tmp/dash-mem-test' },
      },
      {},
    );
    // biome-ignore lint/suspicious/noExplicitAny: buildCustomTools is private
    const names = (backend as any).buildCustomTools().map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['save_memory', 'recall_memory', 'forget_memory']),
    );
  });

  it('skips them when memory.tools === false or memory is absent', () => {
    const a = memoryBackend({ dir: '/tmp/dash-mem-test', tools: false });
    const b = memoryBackend(undefined);
    for (const backend of [a, b]) {
      // biome-ignore lint/suspicious/noExplicitAny: buildCustomTools is private
      const names = (backend as any).buildCustomTools().map((t: { name: string }) => t.name);
      expect(names).not.toContain('save_memory');
      expect(names).not.toContain('recall_memory');
      expect(names).not.toContain('forget_memory');
    }
  });
});

describe('PiAgentBackend memory event bridge', () => {
  function bridgeBackend() {
    return new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'p' },
      {},
    );
  }

  // biome-ignore lint/suspicious/noExplicitAny: normalizeEvents is private, event is a test mock
  function normalize(backend: PiAgentBackend, event: any): AgentEvent[] {
    // biome-ignore lint/suspicious/noExplicitAny: normalizeEvents is private
    return (backend as any).normalizeEvents(event);
  }

  it('follows a successful save_memory tool_result with memory_saved', () => {
    const events = normalize(bridgeBackend(), {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'save_memory',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Saved memory "a" (created).' }],
        details: { memory: { name: 'a', description: 'd', memoryType: 'user', action: 'created' } },
      },
    });
    expect(events.map((e) => e.type)).toEqual(['tool_result', 'memory_saved']);
    expect(events[1]).toEqual({
      type: 'memory_saved',
      name: 'a',
      description: 'd',
      memoryType: 'user',
      action: 'created',
    });
  });

  it('reads memoryType (not the `type` discriminant) off details.memory', () => {
    // Guard against `details.memory.type` — the tools' details are typed `any`
    // at this boundary, so that typo compiles fine. `type` here is a decoy the
    // real payload never carries; reading it would surface 'reference'.
    const events = normalize(bridgeBackend(), {
      type: 'tool_execution_end',
      toolCallId: 'c1b',
      toolName: 'save_memory',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Saved memory "b" (updated).' }],
        details: {
          memory: {
            name: 'b',
            description: 'd2',
            memoryType: 'feedback',
            type: 'reference',
            action: 'updated',
          },
        },
      },
    });
    expect(events).toHaveLength(2);
    const saved = events[1] as Extract<AgentEvent, { type: 'memory_saved' }>;
    expect(saved.type).toBe('memory_saved');
    expect(saved.memoryType).toBe('feedback');
    expect(saved.action).toBe('updated');
  });

  it('emits memory_forgotten after forget_memory and nothing extra on errors', () => {
    const backend = bridgeBackend();
    const ok = normalize(backend, {
      type: 'tool_execution_end',
      toolCallId: 'c2',
      toolName: 'forget_memory',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Forgot memory "a".' }],
        details: { memory: { name: 'a', action: 'forgotten' } },
      },
    });
    expect(ok[1]).toEqual({ type: 'memory_forgotten', name: 'a' });

    const err = normalize(backend, {
      type: 'tool_execution_end',
      toolCallId: 'c3',
      toolName: 'save_memory',
      isError: true,
      result: { content: [{ type: 'text', text: 'Error: bad' }], details: {} },
    });
    expect(err.map((e) => e.type)).toEqual(['tool_result']);
  });

  it('emits nothing extra when a memory tool result carries no details.memory', () => {
    // recall_memory (and the "not found" paths) return `details: {}`.
    const events = normalize(bridgeBackend(), {
      type: 'tool_execution_end',
      toolCallId: 'c4',
      toolName: 'recall_memory',
      isError: false,
      result: { content: [{ type: 'text', text: '# a (user)' }], details: {} },
    });
    expect(events.map((e) => e.type)).toEqual(['tool_result']);
  });

  it('ignores a `memory` details key from an unrelated tool', () => {
    const events = normalize(bridgeBackend(), {
      type: 'tool_execution_end',
      toolCallId: 'c5',
      toolName: 'read',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'file contents' }],
        details: {
          memory: { name: 'spoofed', description: 'x', memoryType: 'user', action: 'created' },
        },
      },
    });
    expect(events.map((e) => e.type)).toEqual(['tool_result']);
  });

  it('passes non-tool events through as a single-element array and drops unmapped ones', () => {
    const backend = bridgeBackend();
    const passthrough = normalize(backend, {
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi', partial: {} },
    });
    expect(passthrough).toEqual([{ type: 'text_delta', text: 'hi' }]);
    expect(normalize(backend, { type: 'agent_start' })).toEqual([]);
  });
});
