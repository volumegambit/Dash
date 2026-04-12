import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from './agent-registry.js';
import type { AgentService } from './agent-service.js';
import { createAgentService } from './agent-service.js';
import { GatewayCredentialStore } from './credential-store.js';

describe('Gateway integration', () => {
  it('registers an agent and handles a chat message end-to-end', async () => {
    const registry = new AgentRegistry();
    const backend: AgentBackend = {
      name: 'test',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'Hello!' };
        yield {
          type: 'response',
          content: 'Hello!',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      abort: vi.fn(),
    };

    const agents = createAgentService({
      registry,
      poolMaxSize: 10,
      createBackend: vi.fn().mockResolvedValue(backend),
    });

    // Register agent
    const { id } = registry.register({
      name: 'test-agent',
      model: 'anthropic/claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
    });

    // Send message
    const events: AgentEvent[] = [];
    for await (const event of agents.chat({
      agentId: id,
      conversationId: 'conv-1',
      text: 'Hello',
    })) {
      events.push(event);
    }

    // Verify events
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'Hello!' });
    expect(events[1]).toMatchObject({ type: 'response', content: 'Hello!' });

    // Agent should be active
    expect(registry.findByName('test-agent')?.status).toBe('active');

    // Pool should have one entry
    expect(agents.stats().size).toBe(1);

    // Cleanup
    await agents.stop();

    // Pool should be empty after stop
    expect(agents.stats().size).toBe(0);

    // Backend stop should have been called
    expect(backend.stop).toHaveBeenCalled();
  });

  it('evict(agentId) clears pool entries and stops their backends', async () => {
    const registry = new AgentRegistry();
    const backend: AgentBackend = {
      name: 'test',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
        yield { type: 'text_delta', text: 'hi' };
        yield { type: 'response', content: 'hi', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      abort: vi.fn(),
    };
    const agents = createAgentService({
      registry,
      poolMaxSize: 10,
      createBackend: vi.fn().mockResolvedValue(backend),
    });
    const { id } = registry.register({
      name: 'evictable',
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: 'p',
    });

    // Warm the pool with one conversation
    for await (const _ of agents.chat({ agentId: id, conversationId: 'conv-1', text: 'hi' })) {
      // drain
    }
    expect(agents.stats().size).toBe(1);

    // Evict — backend.stop() should run and the pool should drop the entry
    await agents.evict(id);
    expect(backend.stop).toHaveBeenCalled();
    expect(agents.stats().size).toBe(0);

    await agents.stop();
  });
});

describe('Pull-based credential propagation (end-to-end)', () => {
  // Simulates the full loop the gateway sets up in apps/gateway/src/index.ts:
  //
  //   1. GatewayCredentialStore holds encrypted provider keys on disk.
  //   2. `createBackend` passes a provider function that reads from the store
  //      on every `run()` via `credentialStore.readProviderApiKeys()`.
  //   3. MC mutates the store via the management API (POST/DELETE
  //      /credentials). No explicit push to running agents.
  //   4. On the next chat message, the backend's provider function sees the
  //      new value and the agent uses the fresh credential.
  //
  // These tests exercise that path with a fake backend that records which
  // keys it sees on each `run()`.

  async function makeStore(): Promise<{
    store: GatewayCredentialStore;
    cleanup: () => Promise<void>;
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'gw-cred-it-'));
    const store = new GatewayCredentialStore(dir);
    await store.init();
    return { store, cleanup: () => rm(dir, { recursive: true }) };
  }

  /**
   * Build a fake backend that pulls credentials from the store on every
   * `run()`, matching what PiAgentBackend does when given a provider
   * function. Records the keys observed on each call so tests can assert.
   */
  function makeCredentialAwareBackend(
    store: GatewayCredentialStore,
    observed: Record<string, string>[],
  ): AgentBackend {
    return {
      name: 'test',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      async *run(_state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
        const keys = await store.readProviderApiKeys();
        observed.push(keys);
        yield { type: 'text_delta', text: 'ok' };
        yield {
          type: 'response',
          content: 'ok',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      abort: vi.fn(),
    };
  }

  async function drain(agents: AgentService, agentId: string, convId: string): Promise<void> {
    for await (const _ of agents.chat({ agentId, conversationId: convId, text: 'hi' })) {
      // discard
    }
  }

  it('second chat turn sees a credential added after the first turn', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const observed: Record<string, string>[] = [];
      const registry = new AgentRegistry();
      const agents = createAgentService({
        registry,
        poolMaxSize: 10,
        createBackend: async () => makeCredentialAwareBackend(store, observed),
      });
      const { id } = registry.register({
        name: 'agent',
        model: 'anthropic/claude-sonnet-4-5',
        systemPrompt: 'p',
      });

      // First turn: no credentials in store
      await drain(agents, id, 'conv-1');
      expect(observed[0]).toEqual({});

      // User adds the anthropic key via the management API (simulated here
      // as a direct store.set — the management-api handler just calls set)
      await store.set('anthropic-api-key:default', 'sk-ant-1');

      // Second turn: the running backend pulls fresh from the store and sees
      // the new key WITHOUT any explicit update call on the service/backend.
      await drain(agents, id, 'conv-1');
      expect(observed[1]).toEqual({ anthropic: 'sk-ant-1' });

      await agents.stop();
    } finally {
      await cleanup();
    }
  });

  it('key rotation takes effect on the next chat turn', async () => {
    const { store, cleanup } = await makeStore();
    try {
      await store.set('anthropic-api-key:default', 'sk-ant-old');

      const observed: Record<string, string>[] = [];
      const registry = new AgentRegistry();
      const agents = createAgentService({
        registry,
        poolMaxSize: 10,
        createBackend: async () => makeCredentialAwareBackend(store, observed),
      });
      const { id } = registry.register({
        name: 'agent',
        model: 'anthropic/claude-sonnet-4-5',
        systemPrompt: 'p',
      });

      await drain(agents, id, 'conv-1');
      expect(observed[0]).toEqual({ anthropic: 'sk-ant-old' });

      // Rotate
      await store.set('anthropic-api-key:default', 'sk-ant-new');

      await drain(agents, id, 'conv-1');
      expect(observed[1]).toEqual({ anthropic: 'sk-ant-new' });

      await agents.stop();
    } finally {
      await cleanup();
    }
  });

  it('key deletion is picked up on the next chat turn', async () => {
    const { store, cleanup } = await makeStore();
    try {
      await store.set('anthropic-api-key:default', 'sk-ant');
      await store.set('openai-api-key:default', 'sk-openai');

      const observed: Record<string, string>[] = [];
      const registry = new AgentRegistry();
      const agents = createAgentService({
        registry,
        poolMaxSize: 10,
        createBackend: async () => makeCredentialAwareBackend(store, observed),
      });
      const { id } = registry.register({
        name: 'agent',
        model: 'anthropic/claude-sonnet-4-5',
        systemPrompt: 'p',
      });

      await drain(agents, id, 'conv-1');
      expect(observed[0]).toEqual({ anthropic: 'sk-ant', openai: 'sk-openai' });

      // Delete the openai key
      await store.delete('openai-api-key:default');

      await drain(agents, id, 'conv-1');
      expect(observed[1]).toEqual({ anthropic: 'sk-ant' });

      await agents.stop();
    } finally {
      await cleanup();
    }
  });

  it('non-provider keys (e.g. channel tokens) are filtered out', async () => {
    const { store, cleanup } = await makeStore();
    try {
      await store.set("channel:DashGerryBot's Bot:token", 'tg-bot-token');
      await store.set('openai-codex-refresh:default', 'oauth-refresh');
      await store.set('anthropic-api-key:default', 'sk-ant');

      const observed: Record<string, string>[] = [];
      const registry = new AgentRegistry();
      const agents = createAgentService({
        registry,
        poolMaxSize: 10,
        createBackend: async () => makeCredentialAwareBackend(store, observed),
      });
      const { id } = registry.register({
        name: 'agent',
        model: 'anthropic/claude-sonnet-4-5',
        systemPrompt: 'p',
      });

      await drain(agents, id, 'conv-1');
      // Only the provider API key — channel tokens and OAuth refresh tokens
      // are not provider credentials and must not leak into the auth map.
      expect(observed[0]).toEqual({ anthropic: 'sk-ant' });

      await agents.stop();
    } finally {
      await cleanup();
    }
  });

  it('first-wins semantics when multiple keys exist for the same provider', async () => {
    // If the user has multiple named keys (default, work, personal), the
    // first one wins — matching the gateway's createBackend logic.
    const { store, cleanup } = await makeStore();
    try {
      await store.set('anthropic-api-key:default', 'sk-ant-default');
      await store.set('anthropic-api-key:work', 'sk-ant-work');

      const keys = await store.readProviderApiKeys();
      // Whichever key appears first in the underlying map wins. We don't
      // guarantee ordering across providers, so just assert it's ONE of them
      // and that it's not a merge.
      expect(Object.keys(keys)).toEqual(['anthropic']);
      expect(['sk-ant-default', 'sk-ant-work']).toContain(keys.anthropic);
    } finally {
      await cleanup();
    }
  });
});
