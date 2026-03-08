import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmProvider } from '@dash/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashAgent } from './agent.js';
import { JsonlSessionStore } from './session.js';
import type { AgentEvent, AgentState, RunOptions } from './types.js';

// Helper to collect all events from an AsyncGenerator
async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

// Minimal mock backend
function makeBackend(events: AgentEvent[] = [], captureState?: (s: AgentState) => void) {
  return {
    name: 'mock',
    async *run(state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      captureState?.(state);
      for (const e of events) yield e;
    },
    abort: vi.fn(),
  };
}

describe('DashAgent.chat()', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('injects memory preamble into systemPrompt when workspace has MEMORY.md', async () => {
    await writeFile(join(tempDir, 'MEMORY.md'), 'Remember: user likes TypeScript');

    let capturedSystemPrompt = '';
    const backend = makeBackend([], (state) => {
      capturedSystemPrompt = state.systemPrompt;
    });

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
      workspace: tempDir,
    });

    await collect(agent.chat('ch', 'conv1', 'hello'));

    expect(capturedSystemPrompt).toContain('Remember: user likes TypeScript');
    expect(capturedSystemPrompt).toContain('You are a helpful assistant.');
  });

  it('does not inject memory preamble when no workspace set', async () => {
    let capturedSystemPrompt = '';
    const backend = makeBackend([], (state) => {
      capturedSystemPrompt = state.systemPrompt;
    });

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
    });

    await collect(agent.chat('ch', 'conv1', 'hello'));

    expect(capturedSystemPrompt).toBe('You are a helpful assistant.');
  });

  it('saves user message and response to session store', async () => {
    const storeDir = join(tempDir, 'sessions');
    await mkdir(storeDir);

    const backend = makeBackend([{ type: 'text_delta', text: 'hello back' }]);
    const sessionStore = new JsonlSessionStore(storeDir);

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
      sessionStore,
    });

    await collect(agent.chat('ch', 'conv1', 'hello'));

    const session = await sessionStore.load('ch', 'conv1');
    expect(session).not.toBeNull();

    const userMsg = session?.messages.find((m) => m.role === 'user' && m.content === 'hello');
    expect(userMsg).toBeDefined();

    const assistantMsg = session?.messages.find(
      (m) => m.role === 'assistant' && m.content === 'hello back',
    );
    expect(assistantMsg).toBeDefined();
  });

  it('triggers compaction and yields context_compacted event when threshold exceeded', async () => {
    const storeDir = join(tempDir, 'sessions');
    await mkdir(storeDir);

    const mockProvider: LlmProvider = {
      complete: vi.fn().mockResolvedValue({
        content: 'Compacted summary',
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 50 },
        stopReason: 'end_turn',
      }),
      stream: async function* () {},
    };

    const backend = makeBackend([{ type: 'text_delta', text: 'response' }]);
    const sessionStore = new JsonlSessionStore(storeDir);

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
      sessionStore,
      provider: mockProvider,
      modelContextWindow: 10, // tiny threshold so any message exceeds 80%
    });

    // 50 chars / 4 ≈ 12 tokens > 8 (80% of 10)
    const events = await collect(agent.chat('ch', 'conv1', 'a'.repeat(50)));

    expect(events.some((e) => e.type === 'context_compacted')).toBe(true);
    expect(mockProvider.complete).toHaveBeenCalled();
  });

  it('does not compact when provider is not configured', async () => {
    const storeDir = join(tempDir, 'sessions');
    await mkdir(storeDir);

    const backend = makeBackend([{ type: 'text_delta', text: 'response' }]);
    const sessionStore = new JsonlSessionStore(storeDir);

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
      sessionStore,
      // no provider
    });

    const events = await collect(agent.chat('ch', 'conv1', 'hello'));

    expect(events.some((e) => e.type === 'context_compacted')).toBe(false);
  });

  it('compactSession throwing does not break the generator', async () => {
    const storeDir = join(tempDir, 'sessions');
    await mkdir(storeDir);

    const mockProvider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new Error('LLM error')),
      stream: async function* () {},
    };

    // Enough text to trigger compaction with a tiny context window of 10
    const backend = makeBackend([{ type: 'text_delta', text: 'a'.repeat(50) }]);
    const sessionStore = new JsonlSessionStore(storeDir);

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
      sessionStore,
      provider: mockProvider,
      modelContextWindow: 10,
    });

    // Should not throw even though compactSession will reject
    const events = await collect(agent.chat('ch', 'conv6', 'a'.repeat(50)));

    // Generator completed without throwing
    expect(Array.isArray(events)).toBe(true);
    // Compaction was silently skipped — no context_compacted event
    expect(events.some((e) => e.type === 'context_compacted')).toBe(false);
  });

  it('no session persistence when backend yields no text_delta events', async () => {
    const storeDir = join(tempDir, 'sessions');
    await mkdir(storeDir);

    const backend = makeBackend([
      { type: 'tool_use_start', id: 'tu1', name: 'bash' },
      { type: 'tool_result', id: 'tu1', name: 'bash', content: 'output' },
    ]);
    const sessionStore = new JsonlSessionStore(storeDir);

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
      sessionStore,
      // no provider
    });

    await collect(agent.chat('ch', 'conv7', 'run ls'));

    const session = await sessionStore.load('ch', 'conv7');
    expect(session).not.toBeNull();

    // Only the user message should be persisted — no assistant response
    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].role).toBe('user');
    expect(session?.messages[0].content).toBe('run ls');
  });

  it('memory preamble uses fallback when workspace set but MEMORY.md absent', async () => {
    // tempDir has no MEMORY.md — use it directly as the workspace
    let capturedSystemPrompt = '';
    const backend = makeBackend([], (state) => {
      capturedSystemPrompt = state.systemPrompt;
    });

    const agent = new DashAgent(backend, {
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'You are a helpful assistant.',
      workspace: tempDir,
    });

    await collect(agent.chat('ch', 'conv8', 'hello'));

    // Should include the "not yet created" fallback text
    expect(capturedSystemPrompt).toContain('not yet created');
    // Should still end with the original system prompt
    expect(capturedSystemPrompt).toContain('You are a helpful assistant.');
  });
});
