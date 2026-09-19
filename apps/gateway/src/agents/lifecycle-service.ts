import type { AgentClient } from '@dash/agent';
import type { SwarmCoordinator } from '@dash/swarm';
import type { AgentChatCoordinator } from '../agent-chat-coordinator.js';
import type { AgentRegistry, RegisteredAgent } from '../agent-registry.js';
import type { ChannelRegistry } from '../channel-registry.js';
import type { ConversationService } from '../conversation-service.js';
import type { EventBus } from '../event-bus.js';
import type { ExecutionCoordinator } from '../execution-coordinator.js';
import type { DynamicGateway } from '../gateway.js';
import type { SubagentDefinitionRegistry } from '../subagent-definitions.js';

export type AgentLifecycleErrorCode = 'not_found' | 'invalid_config';

/** Expected domain failures; transports choose their own status and response shape. */
export class AgentLifecycleError extends Error {
  constructor(
    readonly code: AgentLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentLifecycleError';
  }
}

export type AgentCreateConfig = Parameters<AgentRegistry['register']>[0];
export type AgentUpdatePatch = Parameters<AgentRegistry['update']>[1];

export interface AgentLifecycleServiceOptions {
  agentRegistry: AgentRegistry;
  channelRegistry: ChannelRegistry;
  gateway: Pick<DynamicGateway, 'registerAgent' | 'deregisterAgent'>;
  agents: Pick<AgentChatCoordinator, 'evict'>;
  execution: Pick<ExecutionCoordinator, 'allowAgent' | 'cancelAgent'>;
  conversationService: Pick<ConversationService, 'archiveAgentConversations'>;
  swarmCoordinator?: Pick<SwarmCoordinator, 'cancelRunsFor'>;
  subagentDefinitions?: Pick<SubagentDefinitionRegistry, 'invalidate'>;
  eventBus?: Pick<EventBus, 'emit'>;
  createBridge: (agentId: string) => AgentClient;
}

export interface AgentLifecycleService {
  create(config: AgentCreateConfig): Promise<RegisteredAgent>;
  update(id: string, patch: AgentUpdatePatch): Promise<RegisteredAgent>;
  remove(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  enable(id: string): Promise<void>;
}

/**
 * Coordinate agent mutations across persistence, execution and channel routing.
 * Share one instance across transports so operations on an agent remain ordered.
 * Request parsing, field allowlists and secret stripping belong to the caller.
 */
export function createAgentLifecycleService(
  options: AgentLifecycleServiceOptions,
): AgentLifecycleService {
  const {
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
  } = options;
  const lifecycleTails = new Map<string, Promise<void>>();

  async function serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = lifecycleTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => completed);
    lifecycleTails.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      // Tails always fulfill, so a failed operation cannot wedge later mutations.
      release();
      if (lifecycleTails.get(id) === tail) lifecycleTails.delete(id);
    }
  }

  function requireAgent(id: string): RegisteredAgent {
    const entry = agentRegistry.get(id);
    if (!entry) throw new AgentLifecycleError('not_found', `Agent '${id}' not found`);
    return entry;
  }

  function invalidConfig(error: unknown): AgentLifecycleError {
    return new AgentLifecycleError(
      'invalid_config',
      error instanceof Error ? error.message : 'Agent config is invalid',
    );
  }

  return {
    async create(config) {
      let entry: RegisteredAgent;
      try {
        entry = agentRegistry.register(config);
      } catch (error) {
        throw invalidConfig(error);
      }
      return serialize(entry.id, async () => {
        gateway.registerAgent(entry.id, createBridge(entry.id));
        await agentRegistry.save();
        eventBus?.emit({ type: 'agent:config-changed', agent: entry.name, fields: ['*'] });
        return entry;
      });
    },

    update(id, patch) {
      return serialize(id, async () => {
        const entry = requireAgent(id);
        // Both blocks affect warm backends' gates, caps and injected tools.
        const oldSubagentBlocks = JSON.stringify([entry.config.swarm, entry.config.subagents]);
        let updated: RegisteredAgent;
        try {
          updated = agentRegistry.update(id, patch);
        } catch (error) {
          throw invalidConfig(error);
        }
        await agentRegistry.save();
        // The roster also snapshots workspace, plugins and name. Any config write
        // invalidates it, even when the sub-agent blocks themselves did not change.
        subagentDefinitions?.invalidate(id);
        eventBus?.emit({
          type: 'agent:config-changed',
          agent: entry.name,
          fields: Object.keys(patch),
        });
        if (
          JSON.stringify([updated.config.swarm, updated.config.subagents]) !== oldSubagentBlocks
        ) {
          await agents.evict(id);
        }
        return updated;
      });
    },

    remove(id) {
      return serialize(id, async () => {
        const entry = requireAgent(id);
        await execution.cancelAgent(id);
        const removedChannels = await gateway.deregisterAgent(id);
        for (const name of removedChannels) channelRegistry.remove(name);
        channelRegistry.removeRoutesForAgent(id);
        // Quiesce swarm runs before tearing down the already-cancelled backend.
        swarmCoordinator?.cancelRunsFor(id);
        await agents.evict(id);
        const archived = conversationService.archiveAgentConversations(id);
        agentRegistry.remove(id);
        subagentDefinitions?.invalidate(id);
        await agentRegistry.save();
        await channelRegistry.save();
        for (const conversation of archived) {
          eventBus?.emit({
            type: 'conversation:changed',
            conversationId: conversation.id,
            revision: conversation.revision,
          });
        }
        eventBus?.emit({ type: 'agent:config-changed', agent: entry.name, fields: ['removed'] });
      });
    },

    disable(id) {
      return serialize(id, async () => {
        const entry = requireAgent(id);
        agentRegistry.disable(id);
        // cancelAgent closes admission synchronously. Save concurrently with provider
        // cleanup, but hold serialization until BOTH settle, including failure paths.
        const results = await Promise.allSettled([
          execution.cancelAgent(id),
          Promise.resolve().then(() => agentRegistry.save()),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
        swarmCoordinator?.cancelRunsFor(id);
        await agents.evict(id);
        eventBus?.emit({ type: 'agent:config-changed', agent: entry.name, fields: ['enabled'] });
      });
    },

    enable(id) {
      return serialize(id, async () => {
        const entry = requireAgent(id);
        agentRegistry.enable(id);
        await agentRegistry.save();
        execution.allowAgent(id);
        eventBus?.emit({ type: 'agent:config-changed', agent: entry.name, fields: ['enabled'] });
      });
    },
  };
}
