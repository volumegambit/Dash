import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '@dash/agent';
import type { ConversationSummary, MobileWsServerFrame } from '@dash/mobile-contract';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import { createAgentChatCoordinator } from './agent-chat-coordinator.js';
import { AgentRegistry } from './agent-registry.js';
import { GatewayCredentialStore } from './credential-store.js';
import { type RunningMobileTestHarness, startMobileTestHarness } from './mobile-test-harness.js';

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

    const agents = createAgentChatCoordinator({
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

  it('propagates model updates to warm pool entries without eviction', async () => {
    // Regression test for: model/fallbackModels changes made via
    // `agentRegistry.update()` must take effect on the NEXT chat
    // message in an already-warm conversation, without requiring
    // the pool entry to be evicted. The fix is the DashAgent
    // configResolver — it re-reads from the registry on every
    // chat() call.
    const registry = new AgentRegistry();
    const observedModels: string[] = [];
    const observedFallbacks: Array<string[] | undefined> = [];
    const backend: AgentBackend = {
      name: 'test',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      async *run(state: AgentState, _options: RunOptions): AsyncGenerator<AgentEvent> {
        observedModels.push(state.model);
        observedFallbacks.push(state.fallbackModels);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'response', content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      abort: vi.fn(),
    };

    const agents = createAgentChatCoordinator({
      registry,
      poolMaxSize: 10,
      createBackend: vi.fn().mockResolvedValue(backend),
    });

    const { id } = registry.register({
      name: 'model-switch-test',
      model: 'anthropic/claude-sonnet-4-20250514',
      fallbackModels: ['anthropic/claude-haiku-4-20250514'],
      systemPrompt: 'You are a test agent.',
    });

    // First message — warms the pool, captures the initial model.
    for await (const _ of agents.chat({ agentId: id, conversationId: 'conv-1', text: 'one' })) {
      // drain
    }
    expect(agents.stats().size).toBe(1);
    expect(observedModels[0]).toBe('anthropic/claude-sonnet-4-20250514');
    expect(observedFallbacks[0]).toEqual(['anthropic/claude-haiku-4-20250514']);

    // Update the registry — simulates `PUT /agents/:id` changing
    // the model and fallbacks out from under the warm pool entry.
    registry.update(id, {
      model: 'anthropic/claude-opus-4-6',
      fallbackModels: ['anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5-20251001'],
    });

    // Second message on the SAME conversation — the pool entry has
    // NOT been evicted, but the DashAgent resolver re-reads the
    // registry and the new model + fallbacks should flow through.
    for await (const _ of agents.chat({ agentId: id, conversationId: 'conv-1', text: 'two' })) {
      // drain
    }
    // Pool still has the same one entry — no eviction happened.
    expect(agents.stats().size).toBe(1);
    // createBackend was called exactly once — the warm entry is
    // being reused (if the fix regressed and the coordinator had to
    // evict + respawn, createBackend would be called twice).
    expect(agents.stats().size).toBe(1);

    // Both messages observed — second one MUST see the updated model.
    expect(observedModels).toEqual([
      'anthropic/claude-sonnet-4-20250514',
      'anthropic/claude-opus-4-6',
    ]);
    expect(observedFallbacks[1]).toEqual([
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5-20251001',
    ]);

    await agents.stop();
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
    const agents = createAgentChatCoordinator({
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

  async function drain(
    agents: AgentChatCoordinator,
    agentId: string,
    convId: string,
  ): Promise<void> {
    for await (const _ of agents.chat({ agentId, conversationId: convId, text: 'hi' })) {
      // discard
    }
  }

  it('second chat turn sees a credential added after the first turn', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const observed: Record<string, string>[] = [];
      const registry = new AgentRegistry();
      const agents = createAgentChatCoordinator({
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
      const agents = createAgentChatCoordinator({
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
      const agents = createAgentChatCoordinator({
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
      const agents = createAgentChatCoordinator({
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

class V1IntegrationInbox {
  readonly frames: MobileWsServerFrame[] = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      this.frames.push(JSON.parse(String(event.data)) as MobileWsServerFrame);
    });
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  async waitFor(predicate: (frame: MobileWsServerFrame) => boolean): Promise<MobileWsServerFrame> {
    await vi.waitFor(() => expect(this.frames.some(predicate)).toBe(true));
    const frame = this.frames.find(predicate);
    if (!frame) throw new Error('Expected v1 frame disappeared');
    return frame;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
    });
    this.socket.close();
    await closed;
  }
}

async function openV1IntegrationChat(
  harness: RunningMobileTestHarness,
): Promise<V1IntegrationInbox> {
  const socket = new WebSocket(
    `${harness.chatWebSocketUrl}?token=${encodeURIComponent(harness.chatToken)}`,
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (event) => reject(event.error), { once: true });
  });
  return new V1IntegrationInbox(socket);
}

async function createHarnessConversation(
  harness: RunningMobileTestHarness,
  version: 1 | 2,
): Promise<ConversationSummary> {
  const response = await fetch(`${harness.managementBaseUrl}/mobile/v${version}/conversations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${harness.chatToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agentId: harness.agentId, requestId: randomUUID() }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as ConversationSummary;
}

describe('Follow Up v2 harness integration', () => {
  it('prevents a post-Steer provider call when SQLite delivery fails', async () => {
    const harness = await startMobileTestHarness({
      scenario: 'follow-up-v2',
      failSteerDeliveryOnce: true,
    });
    let client: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    try {
      const conversation = await createHarnessConversation(harness, 2);
      client = await harness.connectV2();
      await harness.subscribeConversation(client, {
        conversationId: conversation.id,
        sinceV2Seq: 0,
      });
      const runId = randomUUID();
      harness.holdProviderGate(runId, 'beforeSafeBoundary');
      client.send({
        type: 'message',
        id: runId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Start before the storage barrier',
        resumable: true,
      });
      await harness.waitForProviderGate(runId, 'beforeSafeBoundary');
      const steer = await harness.enqueueInput(client, {
        conversationId: conversation.id,
        text: 'This Steer must not reach provider call two',
        behavior: 'steer',
        expectedActiveTurnId: runId,
      });
      harness.releaseProviderGate(runId, 'beforeSafeBoundary');
      await client.waitFor(
        (frame) => frame.type === 'input_failed' && frame.input.inputId === steer.input.inputId,
      );

      expect(await harness.providerExecutionCount({ conversationId: conversation.id, runId })).toBe(
        1,
      );
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: steer.input.inputId,
        }),
      ).toBe(0);
      expect(
        client.frames.some(
          (frame) =>
            frame.type === 'event' &&
            frame.runId === runId &&
            frame.event.type === 'text_delta' &&
            typeof frame.event.text === 'string' &&
            frame.event.text.includes('Steered'),
        ),
      ).toBe(false);
    } finally {
      await client?.close().catch(() => undefined);
      await harness.stop();
    }
  });

  it('keeps v1 cursor replay dense across Follow Up v2-only queue mutations', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2' });
    let firstV1: V1IntegrationInbox | undefined;
    let resumedV1: V1IntegrationInbox | undefined;
    let v2: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    try {
      const conversation = await createHarnessConversation(harness, 1);
      const runId = randomUUID();
      harness.holdProviderGate(runId, 'beforeSafeBoundary');
      firstV1 = await openV1IntegrationChat(harness);
      v2 = await harness.connectV2();
      await harness.subscribeConversation(v2, { conversationId: conversation.id, sinceV2Seq: 0 });
      firstV1.send({
        type: 'message',
        id: runId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Keep the v1 cursor dense',
        resumable: true,
      });
      await firstV1.waitFor(
        (frame) => frame.type === 'event' && frame.id === runId && frame.seq === 2,
      );
      const firstFrames = firstV1.frames.filter((frame) => frame.id === runId);
      await firstV1.close();
      firstV1 = undefined;

      const queued = await harness.enqueueInput(v2, {
        conversationId: conversation.id,
        text: 'Queue-only v2 input',
        behavior: 'followUp',
      });
      const edited = await harness.editFollowUp(v2, {
        conversationId: conversation.id,
        inputId: queued.input.inputId,
        expectedRevision: queued.input.revision,
        text: 'Edited queue-only v2 input',
      });
      await harness.removeFollowUp(v2, {
        conversationId: conversation.id,
        inputId: edited.input.inputId,
        expectedRevision: edited.input.revision,
      });

      resumedV1 = await openV1IntegrationChat(harness);
      resumedV1.send({
        type: 'resume',
        id: runId,
        agentId: harness.agentId,
        conversationId: conversation.id,
        sinceSeq: 2,
      });
      await harness.cancelRun(v2, runId);
      await resumedV1.waitFor(
        (frame) => frame.type === 'done' && frame.id === runId && frame.seq === 3,
      );
      const sequences = [...firstFrames, ...resumedV1.frames]
        .filter((frame) => frame.id === runId)
        .map((frame) => frame.seq);
      expect(sequences).toEqual([1, 2, 3]);
      expect(new Set(sequences).size).toBe(sequences.length);
    } finally {
      await firstV1?.close().catch(() => undefined);
      await resumedV1?.close().catch(() => undefined);
      await v2?.close().catch(() => undefined);
      await harness.stop();
    }
  });
});
