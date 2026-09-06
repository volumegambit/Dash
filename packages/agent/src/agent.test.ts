import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashAgent } from './agent.js';
import { MEMORY_RULES, MEMORY_RULES_READONLY } from './memory/prompt.js';
import { MemoryStore } from './memory/store.js';
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
    async start(_workspace: string): Promise<void> {},
    async *run(state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
      captureState?.(state);
      for (const e of events) yield e;
    },
    abort: vi.fn(),
    async stop(): Promise<void> {},
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

  it('does not inject a memory block when no memory config is set', async () => {
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

  it('threads run identity and the awaited steering callback through unchanged', async () => {
    const received: RunOptions[] = [];
    const backend = {
      ...makeBackend(),
      async *run(_state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
        received.push(options);
        yield* [] as AgentEvent[];
      },
    };
    const agent = new DashAgent(
      backend,
      staticResolver({ model: 'anthropic/claude-3-haiku', systemPrompt: 'test' }),
    );
    const callback = vi.fn(async () => {});
    const options = { runId: 'run-1', onSteerConsumed: callback };

    await collect(agent.chat('ch', 'conv1', 'hello', options));

    expect(received).toEqual([options]);
  });
});

describe('DashAgent memory prompt', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-agent-memory-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends the <memory> block with the index when config.memory is set', async () => {
    await new MemoryStore(dir).save({
      name: 'user-timezone',
      description: 'Gerry is in Singapore',
      type: 'user',
      content: 'UTC+8',
      source: 'agent',
    });

    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });

    const agent = new DashAgent(backend, async () => ({
      model: 'anthropic/claude-sonnet-5',
      systemPrompt: 'base',
      memory: { dir },
    }));

    await collect(agent.chat('ch', 'conv', 'hi'));

    expect(seen[0]).toContain('base\n\n<memory>');
    expect(seen[0]).toContain('- **user-timezone** — Gerry is in Singapore');
  });

  it('uses the read-only memory rules when config.memory.tools is false', async () => {
    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });

    const agent = new DashAgent(backend, async () => ({
      model: 'm',
      systemPrompt: 'base',
      memory: { dir, tools: false },
    }));

    await collect(agent.chat('ch', 'conv', 'hi'));

    expect(seen[0]).toContain('base\n\n<memory>');
    expect(seen[0]).toContain(MEMORY_RULES_READONLY);
    expect(seen[0]).not.toContain('save_memory');
  });

  it('keeps the writable memory rules when config.memory.tools is unset or true', async () => {
    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });

    const agent = new DashAgent(backend, async () => ({
      model: 'm',
      systemPrompt: 'base',
      memory: { dir, tools: true },
    }));

    await collect(agent.chat('ch', 'conv', 'hi'));

    expect(seen[0]).toContain(MEMORY_RULES);
  });

  it('adds no memory block when config.memory is absent, even with a workspace', async () => {
    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });

    const agent = new DashAgent(backend, async () => ({
      model: 'm',
      systemPrompt: 'base',
      workspace: dir,
    }));

    await collect(agent.chat('ch', 'conv', 'hi'));

    expect(seen[0]).toBe('base');
    expect(seen[0]).not.toContain('MEMORY.md');
  });
});

describe('DashAgent location prompt', () => {
  const location = {
    timezone: 'Asia/Singapore',
    utcOffsetMinutes: 480,
    locale: 'en-SG',
    region: 'SG',
  };

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-agent-location-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends an <environment> block when the client reported a location', async () => {
    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });
    const agent = new DashAgent(
      backend,
      staticResolver({ model: 'anthropic/claude-sonnet-5', systemPrompt: 'base' }),
    );

    await collect(agent.chat('ch', 'conv', 'hi', { location }));

    expect(seen[0]).toContain('base\n\n<environment>');
    expect(seen[0]).toContain('- Time zone: Asia/Singapore');
  });

  it('carries the location onto AgentState for the backend', async () => {
    let captured: AgentState | undefined;
    const backend = makeBackend([], (state) => {
      captured = state;
    });
    const agent = new DashAgent(
      backend,
      staticResolver({ model: 'anthropic/claude-sonnet-5', systemPrompt: 'base' }),
    );

    await collect(agent.chat('ch', 'conv', 'hi', { location }));

    expect(captured?.location).toEqual(location);
  });

  it('appends nothing when the client reported no location', async () => {
    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });
    const agent = new DashAgent(
      backend,
      staticResolver({ model: 'anthropic/claude-sonnet-5', systemPrompt: 'base' }),
    );

    await collect(agent.chat('ch', 'conv', 'hi'));

    expect(seen[0]).not.toContain('<environment>');
    expect(seen[0]).toBe('base');
  });

  it('suppresses the block when the agent has location disabled', async () => {
    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });
    const agent = new DashAgent(
      backend,
      staticResolver({
        model: 'anthropic/claude-sonnet-5',
        systemPrompt: 'base',
        location: { enabled: false },
      }),
    );

    await collect(agent.chat('ch', 'conv', 'hi', { location }));

    expect(seen[0]).not.toContain('<environment>');
  });

  it('orders <environment> before <memory>', async () => {
    await new MemoryStore(dir).save({
      name: 'user-timezone',
      description: 'Gerry is in Singapore',
      type: 'user',
      content: 'UTC+8',
      source: 'agent',
    });

    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });
    const agent = new DashAgent(
      backend,
      staticResolver({
        model: 'anthropic/claude-sonnet-5',
        systemPrompt: 'base',
        memory: { dir },
      }),
    );

    await collect(agent.chat('ch', 'conv', 'hi', { location }));

    const env = seen[0].indexOf('<environment>');
    const mem = seen[0].indexOf('<memory>');
    expect(env).toBeGreaterThan(-1);
    expect(mem).toBeGreaterThan(-1);
    expect(env).toBeLessThan(mem);
  });
});

describe('DashAgent location tool gating', () => {
  const location = {
    timezone: 'Asia/Singapore',
    utcOffsetMinutes: 480,
    locale: 'en-SG',
  };

  async function promptFor(locationConfig?: { enabled: boolean; tool?: boolean }) {
    const seen: string[] = [];
    const backend = makeBackend([], (state) => {
      seen.push(state.systemPrompt);
    });
    const agent = new DashAgent(
      backend,
      staticResolver({
        model: 'anthropic/claude-sonnet-5',
        systemPrompt: 'base',
        ...(locationConfig ? { location: locationConfig } : {}),
      }),
    );
    await collect(agent.chat('ch', 'conv', 'hi', { location }));
    return seen[0];
  }

  it('names get_location only when the caller says it was registered', async () => {
    expect(await promptFor({ enabled: true, tool: true })).toContain('call get_location');
  });

  it('stays silent about the tool by default', async () => {
    // The unsafe direction needs an explicit opt-in: a caller that passes a
    // location without registering the tool must not get a false claim.
    expect(await promptFor()).not.toContain('get_location');
    expect(await promptFor({ enabled: true })).not.toContain('get_location');
  });

  it('does not name get_location when the tool is withheld', async () => {
    expect(await promptFor({ enabled: true, tool: false })).not.toContain('get_location');
  });
});
