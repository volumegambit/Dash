import { describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeServer: vi.fn(),
  createOpencodeClient: vi.fn(),
}));

import type { AgentEvent } from '../types.js';
import { OpenCodeBackend, extractSkillName } from './opencode.js';

function makeBackend() {
  return new OpenCodeBackend(
    { model: 'anthropic/claude-opus-4-5', systemPrompt: 'You are helpful.' },
    {},
  );
}

const makeEvent = (type: string, properties: object) => ({ type, properties });

describe('OpenCodeBackend.normalizeEvent', () => {
  it('returns text_delta for message.part.delta with field=text', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', { sessionID: 'sess-1', field: 'text', delta: 'Hello' }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'text_delta', text: 'Hello' });
  });

  it('returns thinking_delta for message.part.delta with field=reasoning', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', {
        sessionID: 'sess-1',
        field: 'reasoning',
        delta: 'Thinking...',
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'thinking_delta', text: 'Thinking...' });
  });

  it('returns null for message.part.delta with unknown field', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', { sessionID: 'sess-1', field: 'other', delta: 'x' }),
      'sess-1',
    );
    expect(result).toBeNull();
  });

  it('filters events from other sessions', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', { sessionID: 'other', field: 'text', delta: 'Hi' }),
      'sess-1',
    );
    expect(result).toBeNull();
  });

  it('returns tool_use_start for pending tool part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'pending', input: {}, raw: '' },
        },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'tool_use_start', id: 'call-1', name: 'bash' });
  });

  it('returns tool_use_delta for running tool part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'running', input: { command: 'ls -la' } },
        },
      }),
      'sess-1',
    );
    expect(result).toEqual({
      type: 'tool_use_delta',
      partial_json: JSON.stringify({ command: 'ls -la' }),
    });
  });

  it('deduplicates tool_use_delta — second running event for same callID returns null', () => {
    const backend = makeBackend();
    const runningEvent = makeEvent('message.part.updated', {
      part: {
        type: 'tool',
        sessionID: 'sess-1',
        callID: 'call-dup',
        tool: 'bash',
        state: { status: 'running', input: { command: 'echo hello' } },
      },
    });

    const first = backend.normalizeEvent(runningEvent, 'sess-1');
    expect(first).toEqual({
      type: 'tool_use_delta',
      partial_json: JSON.stringify({ command: 'echo hello' }),
    });

    const second = backend.normalizeEvent(runningEvent, 'sess-1');
    expect(second).toBeNull();
  });

  it('clears dedup state after tool completes, allowing new calls with same ID', () => {
    const backend = makeBackend();

    // First running event for call-1
    backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'running', input: { command: 'ls' } },
        },
      }),
      'sess-1',
    );

    // Complete the tool
    backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'completed', input: {}, output: 'done', title: 'bash', metadata: {}, time: { start: 0, end: 1 } },
        },
      }),
      'sess-1',
    );

    // A new running event for the same callID should emit again
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'running', input: { command: 'pwd' } },
        },
      }),
      'sess-1',
    );
    expect(result).toEqual({
      type: 'tool_use_delta',
      partial_json: JSON.stringify({ command: 'pwd' }),
    });
  });

  it('returns tool_result for completed tool part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: {
            status: 'completed',
            input: {},
            output: 'done',
            title: 'bash',
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'tool_result', id: 'call-1', name: 'bash', content: 'done' });
  });

  it('returns file_changed for patch part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: { type: 'patch', sessionID: 'sess-1', hash: 'abc', files: ['src/foo.ts'] },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'file_changed', files: ['src/foo.ts'] });
  });

  it('returns context_compacted for compaction part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: { type: 'compaction', sessionID: 'sess-1', auto: true, overflow: true },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'context_compacted', overflow: true });
  });

  it('returns null for session.status idle (handled by run loop, not normalizeEvent)', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('session.status', { sessionID: 'sess-1', status: { type: 'idle' } }),
      'sess-1',
    );
    expect(result).toBeNull();
  });

  it('returns agent_retry for session.status retry', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('session.status', {
        sessionID: 'sess-1',
        status: { type: 'retry', attempt: 2, message: 'Rate limit' },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'agent_retry', attempt: 2, reason: 'Rate limit' });
  });

  it('returns error for session.error', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('session.error', { sessionID: 'sess-1', error: { message: 'API key invalid' } }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'error', error: new Error('API key invalid') });
  });

  it('returns question for question.asked', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('question.asked', {
        sessionID: 'sess-1',
        id: 'q-1',
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
          },
        ],
      }),
      'sess-1',
    );
    expect(result).toEqual({
      type: 'question',
      id: 'q-1',
      question: 'Which approach?',
      options: ['A', 'B'],
    });
  });

  it('returns null for unknown event type', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(makeEvent('tui.prompt.append', { text: 'x' }), 'sess-1');
    expect(result).toBeNull();
  });

  it('calls logger.error with structured context when a session.error event fires', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const backend = new OpenCodeBackend(
      { model: 'anthropic/claude-haiku-4-5', systemPrompt: '', tools: [] },
      {},
      mockLogger,
    );
    const errorProps = {
      sessionID: 'sess-1',
      error: { message: 'API key invalid', code: 'AUTH_ERR' },
    };
    backend.normalizeEvent(makeEvent('session.error', errorProps), 'sess-1');
    expect(mockLogger.error).toHaveBeenCalledWith('[OpenCode] session.error: API key invalid', {
      sessionId: 'sess-1',
      errorCode: 'AUTH_ERR',
      rawProps: JSON.stringify(errorProps),
    });
    await backend.stop();
  });

  it('calls logger.warn with structured context when a permission.asked event fires', async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // We need to test the run() loop's permission handling, so we stub the SDK
    const mockPermissionReply = vi.fn().mockResolvedValue({});
    const mockSdk = {
      auth: { set: vi.fn().mockResolvedValue({}) },
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield makeEvent('permission.asked', {
              sessionID: 'sess-run',
              id: 'perm-1',
              permission: 'fs.write',
              patterns: ['**/*.ts'],
            });
            yield makeEvent('session.status', {
              sessionID: 'sess-run',
              status: { type: 'idle' },
            });
          })(),
        }),
      },
      session: {
        prompt: vi.fn().mockResolvedValue({}),
      },
      permission: { reply: mockPermissionReply },
    };

    const { createOpencodeServer, createOpencodeClient } = await import('@opencode-ai/sdk/v2');
    vi.mocked(createOpencodeServer).mockResolvedValue({
      url: 'http://localhost:9999',
      close: vi.fn(),
    } as any);
    vi.mocked(createOpencodeClient).mockReturnValue(mockSdk as any);

    const backend = new OpenCodeBackend(
      { model: 'anthropic/claude-haiku-4-5', systemPrompt: '' },
      {},
      mockLogger,
    );

    // Stub sessionIdMap to avoid real SDK calls
    (backend as any).sessionIdMap = {
      init: vi.fn().mockResolvedValue(undefined),
      getOrCreate: vi.fn().mockResolvedValue('sess-run'),
    };

    await backend.start('/tmp');

    // Consume the generator to completion
    const events: AgentEvent[] = [];
    for await (const ev of backend.run(
      {
        channelId: 'ch-1',
        conversationId: 'conv-1',
        model: 'anthropic/claude-haiku-4-5',
        message: 'hello',
        systemPrompt: '',
        tools: [],
      },
      {},
    )) {
      events.push(ev);
    }

    expect(mockLogger.warn).toHaveBeenCalledWith('[OpenCode] auto-approving permission: fs.write', {
      patterns: JSON.stringify(['**/*.ts']),
      sessionId: 'sess-run',
    });
    await backend.stop();
  });
});

describe('OpenCodeBackend watchdog', () => {
  // Helper to set up a backend with a mock SDK and start it
  async function makeStartedBackend(mockLogger?: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  }) {
    const { createOpencodeServer, createOpencodeClient } = await import('@opencode-ai/sdk/v2');

    const mockClose = vi.fn();
    vi.mocked(createOpencodeServer).mockResolvedValue({
      url: 'http://localhost:9999',
      close: mockClose,
    } as any);

    const mockSdk = {
      auth: { set: vi.fn().mockResolvedValue({}) },
      app: { skills: vi.fn().mockResolvedValue({ data: [] }) },
    };
    vi.mocked(createOpencodeClient).mockReturnValue(mockSdk as any);

    const backend = new OpenCodeBackend(
      { model: 'anthropic/claude-opus-4-5', systemPrompt: '' },
      {},
      mockLogger,
    );

    // Stub sessionIdMap to avoid real SDK calls
    (backend as any).sessionIdMap = {
      init: vi.fn().mockResolvedValue(undefined),
      getOrCreate: vi.fn().mockResolvedValue('sess-1'),
    };

    await backend.start('/tmp/test-workspace');

    return { backend, mockClose, createOpencodeServer, createOpencodeClient };
  }

  it('healthy poll resets failure count', async () => {
    vi.useFakeTimers();
    // Mock fetch to return ok responses
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const { backend } = await makeStartedBackend();

    // Advance time to trigger 3 polls
    await vi.advanceTimersByTimeAsync(15_000);

    // watchdogFailureCount should be 0 since all polls succeeded
    expect((backend as any).watchdogFailureCount).toBe(0);

    await backend.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('3 consecutive failures trigger a restart', async () => {
    vi.useFakeTimers();

    // Mock fetch to always fail
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { backend, createOpencodeServer } = await makeStartedBackend(mockLogger);

    // Reset mock to track restart calls (first call was from start())
    const firstCallCount = vi.mocked(createOpencodeServer).mock.calls.length;

    // Advance time to trigger 3 failures (3 polls at 5s each = 15s)
    // restartWithBackoff has a 1s delay before first attempt, so advance more
    await vi.advanceTimersByTimeAsync(16_001);

    // createOpencodeServer should have been called again for restart
    expect(vi.mocked(createOpencodeServer).mock.calls.length).toBeGreaterThan(firstCallCount);

    await backend.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restart cap stops watchdog after max restarts', async () => {
    vi.useFakeTimers();

    // Mock fetch to always fail (health check fails)
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { backend } = await makeStartedBackend(mockLogger);

    // Force watchdog state to already be at the max restart cap and within the window
    // so the next interval poll immediately triggers the cap stop branch
    (backend as any).watchdogRestartCount = 5; // already at WATCHDOG_MAX_RESTARTS
    (backend as any).watchdogWindowStart = Date.now();

    // Advance time to trigger 3 consecutive failures (threshold = 3) — 3 polls × 5s = 15s
    await vi.advanceTimersByTimeAsync(15_001);

    // After hitting max restarts, watchdog should be stopped and sdk null
    expect((backend as any).watchdogInterval).toBeNull();
    expect((backend as any).sdk).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[OpenCode] Watchdog: max restarts exceeded, manual redeploy required',
    );

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('watchdog health URL is updated to the new server URL after a successful restart', async () => {
    vi.useFakeTimers();

    // First 3 fetches fail (triggering a restart), then succeed on the new URL
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { backend, createOpencodeServer } = await makeStartedBackend(mockLogger);

    // Set up the mock for the restarted server with a different URL/port
    const newServerClose = vi.fn();
    vi.mocked(createOpencodeServer).mockResolvedValueOnce({
      url: 'http://localhost:19999',
      close: newServerClose,
    } as any);

    // Advance time to trigger 3 failures and the subsequent restart
    // 3 polls × 5s = 15s, plus restartWithBackoff 1s delay
    await vi.advanceTimersByTimeAsync(16_001);

    // After restart, watchdogHealthUrl should be updated to the new server URL
    expect((backend as any).watchdogHealthUrl).toBe('http://localhost:19999');

    // Now switch fetch to succeed so the next poll on the new URL can verify correctness
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    // Advance time for one more poll cycle
    await vi.advanceTimersByTimeAsync(5_000);

    // The fetch was called with the new URL (not the old http://localhost:9999)
    const fetchCalls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    const newUrlPolls = fetchCalls.filter((url: string) => url === 'http://localhost:19999/health');
    expect(newUrlPolls.length).toBeGreaterThan(0);

    // Failure count reset after a healthy poll
    expect((backend as any).watchdogFailureCount).toBe(0);

    await backend.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('API keys are re-registered on the new client after a watchdog restart', async () => {
    vi.useFakeTimers();

    // Mock fetch to always fail so health checks trigger a restart
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { createOpencodeServer, createOpencodeClient } = await import('@opencode-ai/sdk/v2');

    const mockClose = vi.fn();
    vi.mocked(createOpencodeServer).mockResolvedValue({
      url: 'http://localhost:9999',
      close: mockClose,
    } as any);

    // Create a second mock SDK to represent the client created after restart
    const newMockSdk = {
      auth: { set: vi.fn().mockResolvedValue({}) },
      app: { skills: vi.fn().mockResolvedValue({ data: [] }) },
    };

    // First call returns base SDK, second call (after restart) returns newMockSdk
    vi.mocked(createOpencodeClient)
      .mockReturnValueOnce({
        auth: { set: vi.fn().mockResolvedValue({}) },
        app: { skills: vi.fn().mockResolvedValue({ data: [] }) },
      } as any)
      .mockReturnValueOnce(newMockSdk as any);

    const backend = new OpenCodeBackend(
      { model: 'anthropic/claude-opus-4-5', systemPrompt: '' },
      { anthropic: 'test-api-key-123' },
      mockLogger,
    );

    (backend as any).sessionIdMap = {
      init: vi.fn().mockResolvedValue(undefined),
      getOrCreate: vi.fn().mockResolvedValue('sess-1'),
    };

    await backend.start('/tmp/test-workspace');

    // Advance time to trigger 3 failures and the restart (3×5s polls + 1s backoff delay)
    await vi.advanceTimersByTimeAsync(16_001);

    // The new SDK's auth.set should have been called with the provider key
    expect(newMockSdk.auth.set).toHaveBeenCalledWith({
      providerID: 'anthropic',
      auth: { type: 'api', key: 'test-api-key-123' },
    });

    await backend.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('concurrent restart attempts are skipped when watchdogRestarting is already true', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { backend, createOpencodeServer } = await makeStartedBackend(mockLogger);

    // Record how many times createOpencodeServer was called during start()
    const callsBeforeRestart = vi.mocked(createOpencodeServer).mock.calls.length;

    // Manually set watchdogRestarting = true to simulate an in-progress restart
    (backend as any).watchdogRestarting = true;
    // Also force failure count to threshold so the watchdog would normally trigger a restart
    (backend as any).watchdogFailureCount = 3;

    // Advance time by one poll interval — the watchdog fires but should skip because
    // watchdogRestarting is already true
    await vi.advanceTimersByTimeAsync(5_001);

    // createOpencodeServer should NOT have been called again (no new restart launched)
    expect(vi.mocked(createOpencodeServer).mock.calls.length).toBe(callsBeforeRestart);

    // watchdogRestartCount should not have incremented either
    // (it was 0 at start, and no new restart was initiated)
    expect((backend as any).watchdogRestartCount).toBe(0);

    await backend.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stop() clears the watchdog interval', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const { backend } = await makeStartedBackend();

    // Verify watchdog is running before stop (interval handle exists)
    expect((backend as any).watchdogInterval).not.toBeNull();

    await backend.stop();

    // Watchdog interval handle should be cleared to null after stop
    expect((backend as any).watchdogInterval).toBeNull();

    // Spy on clearInterval to verify it was called; checking watchdogInterval=null is sufficient
    // since we already verified no handle remains — the interval will not fire again
    const callsAfterStop = mockFetch.mock.calls.length;

    // Advance by a full poll cycle to confirm no new polls are scheduled
    await vi.advanceTimersByTimeAsync(5_000);

    // No additional fetch calls should have been made beyond those already in-flight
    // (the interval is gone, so no new poll callbacks are scheduled)
    expect((backend as any).watchdogInterval).toBeNull();
    expect(mockFetch.mock.calls.length).toBe(callsAfterStop);

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe('extractSkillName', () => {
  it('returns skill name from a completed skill tool event', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'skill',
          callID: 'call-1',
          state: {
            status: 'completed',
            input: { name: 'brainstorming' },
            output: '<skill_content name="brainstorming">...</skill_content>',
          },
        },
      },
    };
    expect(extractSkillName(event)).toBe('brainstorming');
  });

  it('returns null for non-skill tools', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call-2',
          state: { status: 'completed', input: { command: 'ls' }, output: 'file.ts' },
        },
      },
    };
    expect(extractSkillName(event)).toBeNull();
  });

  it('returns null when status is not completed', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'skill',
          callID: 'call-3',
          state: { status: 'running', input: { name: 'debugging' } },
        },
      },
    };
    expect(extractSkillName(event)).toBeNull();
  });

  it('returns null when input has no name', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'skill',
          callID: 'call-4',
          state: { status: 'completed', input: {}, output: '' },
        },
      },
    };
    expect(extractSkillName(event)).toBeNull();
  });
});
