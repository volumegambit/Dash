import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentClient } from '@dash/agent';
import { AgentRegistry, type GatewayAgentConfig } from '../agent-registry.js';
import { ChannelRegistry } from '../channel-registry.js';
import type { ConversationService } from '../conversation-service.js';
import { EventBus, type GatewayEvent } from '../event-bus.js';
import { AgentLifecycleError, createAgentLifecycleService } from './lifecycle-service.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const config: GatewayAgentConfig = {
  name: 'Helper',
  model: 'test/model',
  systemPrompt: 'Help with the task.',
};

function createFixture(filePath?: string) {
  const order: string[] = [];
  const agentRegistry = new AgentRegistry(filePath);
  const channelRegistry = new ChannelRegistry();
  const agentSave = vi.spyOn(agentRegistry, 'save');
  const channelSave = vi.spyOn(channelRegistry, 'save');
  const bridge: AgentClient = {
    async *chat() {},
    async listSkills() {
      return [];
    },
  };
  const createBridge = vi.fn(() => bridge);
  const gateway = {
    registerAgent: vi.fn(() => {
      order.push('bridge');
    }),
    deregisterAgent: vi.fn(async () => {
      order.push('deregister');
      return [] as string[];
    }),
  };
  const agents = {
    evict: vi.fn(async () => {
      order.push('evict');
    }),
  };
  const execution = {
    cancelAgent: vi.fn(async () => {
      order.push('cancel');
    }),
    allowAgent: vi.fn(() => {
      order.push('allow');
    }),
  };
  const conversationService = {
    archiveAgentConversations: vi
      .fn<ConversationService['archiveAgentConversations']>()
      .mockImplementation(() => {
        order.push('archive');
        return [];
      }),
  };
  const swarmCoordinator = {
    cancelRunsFor: vi.fn(() => {
      order.push('swarm');
    }),
  };
  const subagentDefinitions = {
    invalidate: vi.fn(() => {
      order.push('invalidate');
    }),
  };
  const eventBus = new EventBus();
  const events: GatewayEvent[] = [];
  eventBus.subscribe((event) => {
    order.push('event');
    events.push(event);
  });
  const service = createAgentLifecycleService({
    agentRegistry,
    channelRegistry,
    gateway,
    agents,
    execution,
    conversationService,
    swarmCoordinator,
    subagentDefinitions,
    eventBus,
    createBridge,
  });
  return {
    service,
    agentRegistry,
    channelRegistry,
    agentSave,
    channelSave,
    bridge,
    createBridge,
    gateway,
    agents,
    execution,
    conversationService,
    swarmCoordinator,
    subagentDefinitions,
    events,
    order,
  };
}

describe('agent lifecycle service', () => {
  it('registers the bridge and persists before publishing the created agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-lifecycle-'));
    const filePath = join(directory, 'agents.json');
    const fixture = createFixture(filePath);
    const saved = deferred();
    const persist = AgentRegistry.prototype.save.bind(fixture.agentRegistry);
    fixture.agentSave.mockImplementation(async () => {
      fixture.order.push('save');
      await saved.promise;
      await persist();
    });
    try {
      const creating = fixture.service.create(config);
      await vi.waitFor(() => expect(fixture.order).toEqual(['bridge', 'save']));
      expect(fixture.events).toEqual([]);
      saved.resolve();
      const entry = await creating;
      expect(fixture.createBridge).toHaveBeenCalledWith(entry.id);
      expect(fixture.gateway.registerAgent).toHaveBeenCalledWith(entry.id, fixture.bridge);
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual([entry]);
      expect(fixture.events).toEqual([
        { type: 'agent:config-changed', agent: 'Helper', fields: ['*'] },
      ]);
    } finally {
      saved.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports duplicate names as invalid_config without bridge or save side effects', async () => {
    const fixture = createFixture();
    fixture.agentRegistry.register(config);
    await expect(fixture.service.create(config)).rejects.toMatchObject({
      name: 'AgentLifecycleError',
      code: 'invalid_config',
      message: "Agent 'Helper' is already registered",
    });
    expect(fixture.gateway.registerAgent).not.toHaveBeenCalled();
    expect(fixture.agentSave).not.toHaveBeenCalled();
  });

  it.each(['update', 'remove', 'disable', 'enable'] as const)(
    'reports a missing agent from %s with a domain error and no side effects',
    async (operation) => {
      const fixture = createFixture();
      const result =
        operation === 'update'
          ? fixture.service.update('missing', { systemPrompt: 'changed' })
          : fixture.service[operation]('missing');
      await expect(result).rejects.toBeInstanceOf(AgentLifecycleError);
      await expect(result).rejects.toMatchObject({ code: 'not_found' });
      expect(fixture.order).toEqual([]);
      expect(fixture.agentSave).not.toHaveBeenCalled();
      expect(fixture.channelSave).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'update'] as const)(
    'propagates unexpected %s persistence errors and does not publish success',
    async (operation) => {
      const fixture = createFixture();
      const failure = new Error('disk unavailable');
      fixture.agentSave.mockRejectedValueOnce(failure);
      const entry = fixture.agentRegistry.register({ ...config, name: 'Existing' });
      const result =
        operation === 'create'
          ? fixture.service.create(config)
          : fixture.service.update(entry.id, { systemPrompt: 'changed' });
      await expect(result).rejects.toBe(failure);
      expect(fixture.events).toEqual([]);
      expect(fixture.subagentDefinitions.invalidate).not.toHaveBeenCalled();
      expect(fixture.agents.evict).not.toHaveBeenCalled();
    },
  );

  it('maps registry update validation errors without mapping later runtime failures', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register(config);
    vi.spyOn(fixture.agentRegistry, 'update').mockImplementationOnce(() => {
      throw new Error('Agent config is invalid');
    });
    await expect(fixture.service.update(entry.id, {})).rejects.toMatchObject({
      code: 'invalid_config',
      message: 'Agent config is invalid',
    });
    expect(fixture.agentSave).not.toHaveBeenCalled();
  });

  it('saves an update, invalidates the roster, and emits the supplied field names', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register({
      ...config,
      plugins: ['before'],
      providers: ['before'],
    });
    fixture.agentSave.mockImplementation(async () => {
      fixture.order.push('save');
    });
    const updated = await fixture.service.update(entry.id, {
      systemPrompt: 'changed',
      plugins: null,
      providers: null,
    });
    expect(updated).toBe(entry);
    expect(updated.config.systemPrompt).toBe('changed');
    expect(updated.config).not.toHaveProperty('plugins');
    expect(updated.config).not.toHaveProperty('providers');
    expect(fixture.order).toEqual(['save', 'invalidate', 'event']);
    expect(fixture.events).toEqual([
      {
        type: 'agent:config-changed',
        agent: 'Helper',
        fields: ['systemPrompt', 'plugins', 'providers'],
      },
    ]);
    expect(fixture.subagentDefinitions.invalidate).toHaveBeenCalledWith(entry.id);
    expect(fixture.agents.evict).not.toHaveBeenCalled();
  });

  it.each(['swarm', 'subagents'] as const)(
    'evicts after the saved event when the %s configuration changes',
    async (field) => {
      const fixture = createFixture();
      const entry = fixture.agentRegistry.register(config);
      fixture.agentSave.mockImplementation(async () => {
        fixture.order.push('save');
      });
      await fixture.service.update(entry.id, { [field]: { enabled: false } });
      expect(fixture.order).toEqual(['save', 'invalidate', 'event', 'evict']);
      fixture.order.length = 0;
      await fixture.service.update(entry.id, { [field]: { enabled: false } });
      expect(fixture.order).toEqual(['save', 'invalidate', 'event']);
    },
  );

  it('preserves deletion cascade order and removes routing references before publishing', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register(config);
    const other = fixture.agentRegistry.register({ ...config, name: 'Other' });
    const rule = (agentId: string) => ({
      agentId,
      condition: { type: 'default' as const },
      allowList: [],
      denyList: [],
    });
    for (const [name, routing] of [
      ['dedicated', [rule(entry.id)]],
      ['shared', [rule(entry.id), rule(other.id)]],
      ['stopped', [rule(entry.id)]],
    ] as const) {
      fixture.channelRegistry.register({
        name,
        adapter: 'telegram',
        globalDenyList: [],
        routing: [...routing],
      });
    }
    fixture.gateway.deregisterAgent.mockImplementation(async () => {
      fixture.order.push('deregister');
      return ['dedicated'];
    });
    fixture.conversationService.archiveAgentConversations.mockImplementation(() => {
      fixture.order.push('archive');
      expect(fixture.agentRegistry.get(entry.id)).toBe(entry);
      return [
        {
          id: 'conversation',
          agentId: entry.id,
          agentName: entry.name,
          title: 'Saved',
          revision: 4,
          status: 'archived',
          activeTurnId: null,
          owningIssueId: null,
          projectId: null,
          lastSeq: 3,
          lastMessagePreview: null,
          createdAt: 'created',
          updatedAt: 'updated',
          pendingCount: 0,
          pendingScheduling: 'paused',
          queueRevision: 0,
          kind: 'user',
        },
      ];
    });
    fixture.agentSave.mockImplementation(async () => {
      fixture.order.push('agent-save');
      expect(fixture.agentRegistry.get(entry.id)).toBeUndefined();
    });
    fixture.channelSave.mockImplementation(async () => {
      fixture.order.push('channel-save');
    });
    await fixture.service.remove(entry.id);
    expect(fixture.order).toEqual([
      'cancel',
      'deregister',
      'swarm',
      'evict',
      'archive',
      'invalidate',
      'agent-save',
      'channel-save',
      'event',
      'event',
    ]);
    expect(fixture.channelRegistry.list().map((channel) => channel.name)).toEqual(['shared']);
    expect(fixture.channelRegistry.get('shared')?.routing).toEqual([rule(other.id)]);
    expect(fixture.events).toEqual([
      { type: 'conversation:changed', conversationId: 'conversation', revision: 4 },
      { type: 'agent:config-changed', agent: 'Helper', fields: ['removed'] },
    ]);
  });

  it('waits for execution cleanup before deregistering or archiving on removal', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register(config);
    const cleanup = deferred();
    fixture.execution.cancelAgent.mockReturnValue(cleanup.promise);
    const removing = fixture.service.remove(entry.id);
    await vi.waitFor(() => expect(fixture.execution.cancelAgent).toHaveBeenCalledOnce());
    expect(fixture.gateway.deregisterAgent).not.toHaveBeenCalled();
    expect(fixture.conversationService.archiveAgentConversations).not.toHaveBeenCalled();
    expect(fixture.agentRegistry.get(entry.id)).toBe(entry);
    cleanup.resolve();
    await removing;
  });

  it.each(['cleanup', 'save'] as const)(
    'keeps enable queued until both disable operations settle when %s fails',
    async (failing) => {
      const fixture = createFixture();
      const entry = fixture.agentRegistry.register(config);
      const cleanup = deferred();
      const save = deferred();
      const failure = new Error(`${failing} failed`);
      fixture.execution.cancelAgent.mockImplementation(() => {
        fixture.order.push('cancel');
        expect(fixture.agentRegistry.get(entry.id)?.status).toBe('disabled');
        return cleanup.promise;
      });
      fixture.agentSave.mockImplementationOnce(() => {
        fixture.order.push('save');
        expect(fixture.execution.cancelAgent).toHaveBeenCalledOnce();
        return save.promise;
      });
      let settled = false;
      const disabling = fixture.service.disable(entry.id).catch((error: unknown) => {
        settled = true;
        return error;
      });
      await vi.waitFor(() => expect(fixture.order).toEqual(['cancel', 'save']));
      const enabling = fixture.service.enable(entry.id);
      (failing === 'cleanup' ? cleanup : save).reject(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fixture.agentRegistry.get(entry.id)?.status).toBe('disabled');
      expect(fixture.execution.allowAgent).not.toHaveBeenCalled();
      expect(fixture.agents.evict).not.toHaveBeenCalled();
      (failing === 'cleanup' ? save : cleanup).resolve();
      expect(await disabling).toBe(failure);
      await enabling;
      expect(fixture.execution.allowAgent).toHaveBeenCalledWith(entry.id);
      expect(fixture.swarmCoordinator.cancelRunsFor).not.toHaveBeenCalled();
      expect(fixture.agents.evict).not.toHaveBeenCalled();
      expect(fixture.events).toHaveLength(1);
    },
  );

  it('does not enable before disable eviction completes, while another agent can proceed', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register(config);
    const other = fixture.agentRegistry.register({ ...config, name: 'Other' });
    const eviction = deferred();
    fixture.agentSave.mockImplementationOnce(async () => {
      fixture.order.push('save');
    });
    fixture.agents.evict.mockImplementationOnce(() => {
      fixture.order.push('evict');
      return eviction.promise;
    });
    const disabling = fixture.service.disable(entry.id);
    await vi.waitFor(() => expect(fixture.agents.evict).toHaveBeenCalledWith(entry.id));
    expect(fixture.order).toEqual(['cancel', 'save', 'swarm', 'evict']);
    expect(fixture.events).toEqual([]);
    const enabling = fixture.service.enable(entry.id);
    await fixture.service.enable(other.id);
    expect(fixture.execution.allowAgent).toHaveBeenCalledExactlyOnceWith(other.id);
    expect(fixture.agentRegistry.get(entry.id)?.status).toBe('disabled');
    eviction.resolve();
    await disabling;
    await enabling;
    expect(fixture.execution.allowAgent).toHaveBeenLastCalledWith(entry.id);
    expect(fixture.events).toEqual([
      { type: 'agent:config-changed', agent: 'Other', fields: ['enabled'] },
      { type: 'agent:config-changed', agent: 'Helper', fields: ['enabled'] },
      { type: 'agent:config-changed', agent: 'Helper', fields: ['enabled'] },
    ]);
  });

  it('serializes updates and removal behind disable and checks existence after removal', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register(config);
    const cleanup = deferred();
    fixture.execution.cancelAgent.mockReturnValueOnce(cleanup.promise);
    const disabling = fixture.service.disable(entry.id);
    const updating = fixture.service.update(entry.id, { systemPrompt: 'changed' });
    const removing = fixture.service.remove(entry.id);
    const enabling = fixture.service.enable(entry.id).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fixture.execution.cancelAgent).toHaveBeenCalledOnce());
    expect(entry.config.systemPrompt).toBe(config.systemPrompt);
    expect(fixture.gateway.deregisterAgent).not.toHaveBeenCalled();
    cleanup.resolve();
    await disabling;
    expect((await updating).config.systemPrompt).toBe('changed');
    await removing;
    expect(await enabling).toMatchObject({ code: 'not_found' });
    expect(fixture.execution.allowAgent).not.toHaveBeenCalled();
  });

  it('opens admission and emits only after enable persistence succeeds', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register(config);
    fixture.agentRegistry.disable(entry.id);
    const save = deferred();
    fixture.agentSave.mockReturnValueOnce(save.promise);
    const enabling = fixture.service.enable(entry.id);
    await vi.waitFor(() => expect(fixture.agentSave).toHaveBeenCalledOnce());
    expect(fixture.execution.allowAgent).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
    save.resolve();
    await enabling;
    expect(fixture.order).toEqual(['allow', 'event']);
    expect(fixture.agentRegistry.get(entry.id)?.status).toBe('registered');
  });

  it('does not reopen admission after failed enable persistence and permits a later retry', async () => {
    const fixture = createFixture();
    const entry = fixture.agentRegistry.register(config);
    fixture.agentRegistry.disable(entry.id);
    const failure = new Error('disk unavailable');
    fixture.agentSave.mockRejectedValueOnce(failure);
    await expect(fixture.service.enable(entry.id)).rejects.toBe(failure);
    expect(fixture.execution.allowAgent).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
    await fixture.service.enable(entry.id);
    expect(fixture.execution.allowAgent).toHaveBeenCalledWith(entry.id);
  });
});
