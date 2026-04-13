import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashAgent } from './agent.js';
import type { AgentEvent, AgentState, DashAgentConfig, RunOptions } from './types.js';

// Helper to collect all events from an AsyncGenerator
async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/**
 * Wrap a static config in a resolver for tests that don't care about
 * dynamic updates. Equivalent to `async () => config` but more
 * readable at call sites. Tests that DO care about dynamic updates
 * use their own resolver closure.
 */
function staticResolver(config: DashAgentConfig): () => Promise<DashAgentConfig> {
  return async () => config;
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

    const agent = new DashAgent(
      backend,
      staticResolver({
        model: 'anthropic/claude-3-haiku',
        systemPrompt: 'You are a helpful assistant.',
        workspace: tempDir,
      }),
    );

    await collect(agent.chat('ch', 'conv1', 'hello'));

    expect(capturedSystemPrompt).toContain('Remember: user likes TypeScript');
    expect(capturedSystemPrompt).toContain('You are a helpful assistant.');
  });

  it('does not inject memory preamble when no workspace set', async () => {
    let capturedSystemPrompt = '';
    const backend = makeBackend([], (state) => {
      capturedSystemPrompt = state.systemPrompt;
    });

    const agent = new DashAgent(
      backend,
      staticResolver({
        model: 'anthropic/claude-3-haiku',
        systemPrompt: 'You are a helpful assistant.',
      }),
    );

    await collect(agent.chat('ch', 'conv1', 'hello'));

    expect(capturedSystemPrompt).toBe('You are a helpful assistant.');
  });

  it('memory preamble uses fallback when workspace set but MEMORY.md absent', async () => {
    // tempDir has no MEMORY.md — use it directly as the workspace
    let capturedSystemPrompt = '';
    const backend = makeBackend([], (state) => {
      capturedSystemPrompt = state.systemPrompt;
    });

    const agent = new DashAgent(
      backend,
      staticResolver({
        model: 'anthropic/claude-3-haiku',
        systemPrompt: 'You are a helpful assistant.',
        workspace: tempDir,
      }),
    );

    await collect(agent.chat('ch', 'conv8', 'hello'));

    // Should include the "not yet created" fallback text
    expect(capturedSystemPrompt).toContain('not yet created');
    // Should still end with the original system prompt
    expect(capturedSystemPrompt).toContain('You are a helpful assistant.');
  });

  // ------------------------------------------------------------------
  // Config resolver semantics — the whole point of the resolver API
  // is that a config change visible to the resolver takes effect on
  // the NEXT chat() call without requiring the DashAgent instance
  // (and its warm backend) to be rebuilt.
  // ------------------------------------------------------------------

  it('calls the resolver on every chat() invocation', async () => {
    const resolver = vi.fn(async () => ({
      model: 'anthropic/claude-3-haiku',
      systemPrompt: 'test',
    }));
    const backend = makeBackend();
    const agent = new DashAgent(backend, resolver);

    await collect(agent.chat('ch', 'conv1', 'msg1'));
    await collect(agent.chat('ch', 'conv1', 'msg2'));
    await collect(agent.chat('ch', 'conv1', 'msg3'));

    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('picks up model changes between chats without rebuilding the agent', async () => {
    const captured: string[] = [];
    const backend = makeBackend([], (state) => {
      captured.push(state.model);
    });

    // Simulate a mutable "registry" that the resolver reads from.
    let currentModel = 'anthropic/claude-3-haiku';
    const agent = new DashAgent(backend, async () => ({
      model: currentModel,
      systemPrompt: 'test',
    }));

    await collect(agent.chat('ch', 'conv1', 'before change'));

    // External update — e.g. `PUT /agents/:id` bumping the model.
    currentModel = 'anthropic/claude-opus-4-6';

    await collect(agent.chat('ch', 'conv1', 'after change'));

    expect(captured).toEqual(['anthropic/claude-3-haiku', 'anthropic/claude-opus-4-6']);
  });

  it('picks up fallbackModels changes between chats', async () => {
    const captured: Array<string[] | undefined> = [];
    const backend = makeBackend([], (state) => {
      captured.push(state.fallbackModels);
    });

    let currentFallbacks: string[] = ['anthropic/claude-3-haiku'];
    const agent = new DashAgent(backend, async () => ({
      model: 'anthropic/claude-opus-4-6',
      fallbackModels: currentFallbacks,
      systemPrompt: 'test',
    }));

    await collect(agent.chat('ch', 'conv1', 'before'));
    currentFallbacks = ['anthropic/claude-sonnet-4-6', 'anthropic/claude-3-haiku'];
    await collect(agent.chat('ch', 'conv1', 'after'));

    expect(captured[0]).toEqual(['anthropic/claude-3-haiku']);
    expect(captured[1]).toEqual(['anthropic/claude-sonnet-4-6', 'anthropic/claude-3-haiku']);
  });

  it('propagates a resolver rejection as a chat error', async () => {
    const backend = makeBackend();
    const agent = new DashAgent(backend, async () => {
      throw new Error("Agent 'ghost' not found");
    });

    await expect(async () => {
      for await (const _ of agent.chat('ch', 'conv1', 'hi')) {
        // consume
      }
    }).rejects.toThrow(/not found/);
  });
});
