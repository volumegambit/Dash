import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { ChannelAdapter, MessageHandler } from '@dash/channels';
import { vi } from 'vitest';
import { AgentRegistry } from '../agent-registry.js';
import { ChannelRegistry, type ChannelRoutingRule } from '../channel-registry.js';
import { EventBus } from '../event-bus.js';
import { createDynamicGateway } from '../gateway.js';
import { createChannelAdapterFactory } from './adapter-factory.js';
import { ChannelServiceError, createAgentBridge, createChannelService } from './service.js';

function fakeAdapter(): ChannelAdapter & { receive: MessageHandler } {
  const adapter = {
    name: 'telegram',
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    receive: (async () => {}) as MessageHandler,
    onMessage(handler: MessageHandler) {
      adapter.receive = handler;
    },
    getHealth: () => 'connected' as const,
    onHealthChange() {},
  };
  return adapter;
}

describe('channel application service', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'channel-service-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function setup() {
    const agentRegistry = new AgentRegistry();
    const agent = agentRegistry.register({ name: 'alpha', model: 'test', systemPrompt: 'test' });
    const otherAgent = agentRegistry.register({
      name: 'beta',
      model: 'test',
      systemPrompt: 'test',
    });
    const channelRegistry = new ChannelRegistry(join(dataDir, 'channels.json'));
    const gateway = createDynamicGateway({
      resolveRouting: (name) => channelRegistry.get(name) ?? null,
    });
    const credentials = new Map([['channel:bot:token', 'test-token']]);
    const credentialStore = { get: vi.fn(async (key: string) => credentials.get(key) ?? null) };
    const chat = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: 'reply' };
    });
    const agents = { listSkills: vi.fn(async () => []) };
    const execution = { legacy: { chat } };
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => events.push(event));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const adapter = fakeAdapter();
    let allowedUsers: (() => string[]) | undefined;
    const createAdapter = createChannelAdapterFactory({
      dataDir,
      channelRegistry,
      credentialStore,
      adapters: {
        telegram: (_token, readAllowedUsers) => {
          allowedUsers = readAllowedUsers;
          return adapter;
        },
        whatsapp: () => adapter,
      },
    });
    const options = {
      dataDir,
      gateway,
      agentRegistry,
      channelRegistry,
      credentialStore,
      agents,
      execution,
      eventBus,
      logger,
      createAdapter,
    };
    const service = createChannelService(options);
    const rule = (agentId = agent.id): ChannelRoutingRule => ({
      condition: { type: 'default' },
      agentId,
      allowList: [],
      denyList: [],
    });
    const input = { name: 'bot', adapter: 'telegram', routing: [rule()], allowedUsers: ['alice'] };
    return {
      ...options,
      service,
      adapter,
      agent,
      otherAgent,
      credentials,
      chat,
      events,
      rule,
      input,
      allowedUsers: () => allowedUsers?.(),
    };
  }

  it('bridges the execution owner and skill discovery with the stable agent id', async () => {
    const state = setup();
    const bridge = createAgentBridge(state.agent.id, state);
    for await (const event of bridge.chat('telegram', 'chat-1', 'hello'))
      expect(event).toEqual({ type: 'text_delta', text: 'reply' });
    expect(state.chat).toHaveBeenCalledWith({
      agentId: state.agent.id,
      conversationId: 'chat-1',
      channelId: 'telegram',
      text: 'hello',
    });
    expect(await bridge.listSkills?.()).toEqual([]);
    expect(state.agents.listSkills).toHaveBeenCalledWith(state.agent.id);
  });

  it('rejects unknown routing agents before constructing or persisting a channel', async () => {
    const state = setup();
    await expect(
      state.service.create({
        ...state.input,
        routing: [state.rule('missing'), state.rule('missing')],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_config',
      message: 'routing references unknown agent(s): missing',
    });
    expect(state.channelRegistry.list()).toEqual([]);
    expect(state.credentialStore.get).not.toHaveBeenCalled();
  });

  it('pre-registers routing and allowlists before adapter startup and persists before emitting', async () => {
    const state = setup();
    state.adapter.start = vi.fn(async () => {
      expect(state.channelRegistry.get('bot')?.routing).toEqual(state.input.routing);
      expect(state.allowedUsers()).toEqual(['alice']);
    });
    state.eventBus.subscribe(() => {
      expect(state.gateway.channelCount()).toBe(1);
    });
    await state.service.create(state.input);
    expect(JSON.parse(await readFile(join(dataDir, 'channels.json'), 'utf8'))).toMatchObject([
      { name: 'bot', allowedUsers: ['alice'] },
    ]);
    expect(state.events).toEqual([{ type: 'channel:created', channel: 'bot' }]);
    expect(state.gateway.agentCount()).toBe(1);
  });

  it('rejects duplicate names without stopping or replacing the original adapter', async () => {
    const state = setup();
    await state.service.create(state.input);
    await expect(state.service.create(state.input)).rejects.toMatchObject({
      code: 'conflict',
      message: "Channel 'bot' already exists",
    });
    expect(state.adapter.stop).not.toHaveBeenCalled();
    expect(state.gateway.channelCount()).toBe(1);
  });

  it('rolls back both registry and partial runtime state when adapter startup fails', async () => {
    const state = setup();
    const error = new Error('startup failed');
    state.adapter.start = vi.fn(async () => {
      throw error;
    });
    await expect(state.service.create(state.input)).rejects.toBe(error);
    expect(state.channelRegistry.get('bot')).toBeUndefined();
    expect(state.gateway.channelCount()).toBe(0);
    expect(state.adapter.stop).toHaveBeenCalledOnce();
    expect(state.events).toEqual([]);
  });

  it('rolls back pre-registration on missing credentials and factory failure', async () => {
    const state = setup();
    state.credentials.clear();
    await expect(state.service.create(state.input)).rejects.toMatchObject({
      code: 'invalid_config',
      message: "No credential found for key 'channel:bot:token'",
    });
    expect(state.channelRegistry.list()).toEqual([]);
    state.credentialStore.get.mockRejectedValueOnce(new Error('store failed'));
    await expect(state.service.create(state.input)).rejects.toThrow('store failed');
    expect(state.channelRegistry.list()).toEqual([]);
  });

  it('does not roll back a replacement channel when an earlier factory fails', async () => {
    const state = setup();
    const replacementAdapter = fakeAdapter();
    const factoryEntered = Promise.withResolvers<void>();
    const pausedFactory = Promise.withResolvers<ChannelAdapter>();
    let first = true;
    const service = createChannelService({
      ...state,
      createAdapter: async () => {
        if (!first) return replacementAdapter;
        first = false;
        factoryEntered.resolve();
        return pausedFactory.promise;
      },
    });
    const failure = new Error('original factory failed');
    const initialCreate = service.create(state.input);
    const initialFailure = expect(initialCreate).rejects.toBe(failure);
    await factoryEntered.promise;
    await service.remove('bot');
    await service.create({ ...state.input, allowedUsers: ['replacement'] });
    const replacement = state.channelRegistry.get('bot');

    pausedFactory.reject(failure);
    await initialFailure;

    expect(state.channelRegistry.get('bot')).toBe(replacement);
    expect(state.gateway.channelCount()).toBe(1);
    expect(replacementAdapter.stop).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(dataDir, 'channels.json'), 'utf8'))).toMatchObject([
      { name: 'bot', allowedUsers: ['replacement'] },
    ]);
  });

  it('rechecks ownership after awaiting rollback shutdown', async () => {
    const state = setup();
    const failedAdapter = fakeAdapter();
    const replacementAdapter = fakeAdapter();
    const stopEntered = Promise.withResolvers<void>();
    const releaseStop = Promise.withResolvers<void>();
    const failure = new Error('startup failed');
    failedAdapter.start = vi.fn(async () => {
      throw failure;
    });
    failedAdapter.stop = vi.fn(async () => {
      stopEntered.resolve();
      await releaseStop.promise;
    });
    let first = true;
    const service = createChannelService({
      ...state,
      createAdapter: async () => {
        if (!first) return replacementAdapter;
        first = false;
        return failedAdapter;
      },
    });
    const initialCreate = service.create(state.input);
    const initialFailure = expect(initialCreate).rejects.toBe(failure);
    await stopEntered.promise;
    await service.remove('bot');
    await service.create({ ...state.input, allowedUsers: ['replacement'] });
    const replacement = state.channelRegistry.get('bot');

    releaseStop.resolve();
    await initialFailure;

    expect(state.channelRegistry.get('bot')).toBe(replacement);
    expect(state.gateway.channelCount()).toBe(1);
    expect(replacementAdapter.stop).not.toHaveBeenCalled();
  });

  it('updates live routing and allowlists without restarting the adapter', async () => {
    const state = setup();
    state.service.bridgeAgent(state.otherAgent.id);
    await state.service.create(state.input);
    await state.service.update('bot', {
      routing: [state.rule(state.otherAgent.id)],
      allowedUsers: ['bob'],
    });
    expect(state.allowedUsers()).toEqual(['bob']);
    await state.adapter.receive({
      channelId: 'telegram',
      conversationId: 'chat-1',
      senderId: 'bob',
      senderName: 'Bob',
      text: 'hello',
      timestamp: new Date(),
    });
    expect(state.chat).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: state.otherAgent.id }),
    );
    expect(state.adapter.start).toHaveBeenCalledOnce();
    expect(state.events.at(-1)).toEqual({
      type: 'channel:config-changed',
      channel: 'bot',
      fields: ['routing', 'allowedUsers'],
    });
  });

  it('rejects invalid patches without changing routing', async () => {
    const state = setup();
    await state.service.create(state.input);
    await expect(
      state.service.update('bot', { routing: [state.rule('missing')] }),
    ).rejects.toBeInstanceOf(ChannelServiceError);
    await expect(
      state.service.update('bot', { allowedUsers: 'bad' as unknown as string[] }),
    ).rejects.toMatchObject({
      code: 'invalid_config',
      message: 'allowedUsers must be an array of strings',
    });
    expect(state.channelRegistry.get('bot')?.routing).toEqual(state.input.routing);
  });

  it('stops before removing and persists deletion before the removed event', async () => {
    const state = setup();
    await state.service.create(state.input);
    state.adapter.stop = vi.fn(async () => {
      expect(state.channelRegistry.has('bot')).toBe(true);
    });
    await state.service.remove('bot');
    expect(state.adapter.stop).toHaveBeenCalledOnce();
    expect(state.gateway.channelCount()).toBe(0);
    expect(JSON.parse(await readFile(join(dataDir, 'channels.json'), 'utf8'))).toEqual([]);
    expect(state.events.at(-1)).toEqual({ type: 'channel:removed', channel: 'bot' });
    expect(state.allowedUsers()).toEqual([]);
  });

  it('reports absent channels as domain errors', async () => {
    const state = setup();
    await expect(state.service.update('missing', {})).rejects.toMatchObject({
      code: 'not_found',
      message: 'not found',
    });
    await expect(state.service.remove('missing')).rejects.toMatchObject({
      code: 'not_found',
      message: 'not found',
    });
  });

  it('isolates restore failures without removing persisted channel entries or exposing errors', async () => {
    const state = setup();
    state.channelRegistry.register({ ...state.input, adapter: 'telegram', globalDenyList: [] });
    state.channelRegistry.register({
      ...state.input,
      name: 'working',
      adapter: 'telegram',
      globalDenyList: [],
    });
    const working = fakeAdapter();
    const service = createChannelService({
      ...state,
      createAdapter: async (channel) => {
        if (channel.name === 'bot') throw new Error('secret-token');
        return working;
      },
    });
    await service.restoreAll();
    expect(state.gateway.channelCount()).toBe(1);
    expect(state.channelRegistry.list()).toHaveLength(2);
    expect(working.start).toHaveBeenCalledOnce();
    expect(state.logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.logger.warn.mock.calls)).not.toContain('secret-token');
    expect(state.events).toEqual([]);
  });

  it('restarts a Telegram adapter with rotated credentials and live allowlists', async () => {
    const state = setup();
    await state.service.create(state.input);
    state.credentials.set('channel:bot:token', 'new-token');
    await state.service.restartForCredential('channel:bot:token');
    expect(state.adapter.stop).toHaveBeenCalledOnce();
    expect(state.adapter.start).toHaveBeenCalledTimes(2);
    expect(state.events.at(-1)).toEqual({
      type: 'channel:restarted',
      channel: 'bot',
      reason: 'token-rotation',
    });
  });

  it('keeps credential restart best-effort including credential read failures', async () => {
    const state = setup();
    await state.service.create(state.input);
    state.credentialStore.get.mockRejectedValueOnce(new Error('credential-secret'));
    await expect(state.service.restartForCredential('channel:bot:token')).resolves.toBeUndefined();
    expect(JSON.stringify(state.logger.error.mock.calls)).not.toContain('credential-secret');
    state.adapter.start = vi.fn(async () => {
      throw new Error('adapter-secret');
    });
    await expect(state.service.restartForCredential('channel:bot:token')).resolves.toBeUndefined();
    expect(state.channelRegistry.has('bot')).toBe(true);
    expect(state.logger.error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.logger.error.mock.calls)).not.toContain('adapter-secret');
  });

  it('ignores unrelated credentials, absent channels, and missing replacement tokens', async () => {
    const state = setup();
    await state.service.restartForCredential('provider:key');
    await state.service.restartForCredential('channel:missing:token');
    expect(state.credentialStore.get).not.toHaveBeenCalled();
    await state.service.create(state.input);
    state.credentials.clear();
    await state.service.restartForCredential('channel:bot:token');
    expect(state.adapter.stop).not.toHaveBeenCalled();
  });
});
