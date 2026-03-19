import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashAgent } from './agent.js';
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
