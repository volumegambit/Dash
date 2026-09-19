import type { AgentClient } from '@dash/agent';
import { type Logger, createConsoleLogger } from '@dash/logging';
import type { AgentChatCoordinator } from '../agent-chat-coordinator.js';
import type { AgentRegistry } from '../agent-registry.js';
import type {
  ChannelConfig,
  ChannelRegistry,
  ChannelRoutingRule,
  RegisteredChannel,
} from '../channel-registry.js';
import type { GatewayCredentialStore } from '../credential-store.js';
import type { EventBus } from '../event-bus.js';
import type { ExecutionCoordinator } from '../execution-coordinator.js';
import type { DynamicGateway } from '../gateway.js';
import {
  ChannelAdapterConfigurationError,
  type ChannelAdapterFactory,
  createChannelAdapterFactory,
} from './adapter-factory.js';

export type ChannelServiceErrorCode = 'not_found' | 'invalid_config' | 'conflict';

export class ChannelServiceError extends Error {
  constructor(
    readonly code: ChannelServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelServiceError';
  }
}

export interface AgentBridgeDependencies {
  execution: { legacy: Pick<ExecutionCoordinator['legacy'], 'chat'> };
  agents: Pick<AgentChatCoordinator, 'listSkills'>;
}

/** Every channel bridge dispatches through the same execution owner. */
export function createAgentBridge(
  agentId: string,
  dependencies: AgentBridgeDependencies,
): AgentClient {
  return {
    chat(channelId, conversationId, text) {
      return dependencies.execution.legacy.chat({ agentId, conversationId, channelId, text });
    },
    listSkills() {
      return dependencies.agents.listSkills(agentId);
    },
  };
}

export interface CreateChannelInput {
  name: string;
  adapter: string;
  routing: ChannelRoutingRule[];
  globalDenyList?: string[];
  allowedUsers?: string[];
}

export type UpdateChannelInput = Partial<Omit<ChannelConfig, 'name'>>;

export interface ChannelServiceOptions extends AgentBridgeDependencies {
  gateway: DynamicGateway;
  agentRegistry: Pick<AgentRegistry, 'get'>;
  channelRegistry: ChannelRegistry;
  credentialStore: Pick<GatewayCredentialStore, 'get'>;
  dataDir: string;
  eventBus?: Pick<EventBus, 'emit'>;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  createAdapter?: ChannelAdapterFactory;
}

export interface ChannelService {
  bridgeAgent(id: string): void;
  create(input: CreateChannelInput): Promise<void>;
  update(name: string, patch: UpdateChannelInput): Promise<RegisteredChannel>;
  remove(name: string): Promise<void>;
  restoreAll(): Promise<void>;
  restartForCredential(key: string): Promise<void>;
}

/** Describe failures without logging messages, causes, stacks, or credential contents. */
function failureContext(error: unknown, channel: string): Record<string, unknown> {
  if (error instanceof Error || typeof error === 'string') {
    return {
      channel,
      errorKind: error instanceof Error ? 'error' : 'string',
      errorMessageLength: typeof error === 'string' ? error.length : error.message.length,
    };
  }
  return {
    channel,
    errorKind: error === null ? 'null' : Array.isArray(error) ? 'array' : typeof error,
  };
}

export function createChannelService(options: ChannelServiceOptions): ChannelService {
  const { gateway, agentRegistry, channelRegistry, credentialStore, eventBus } = options;
  const logger = options.logger ?? createConsoleLogger('info', 'text', 'gateway-channels');
  const createAdapter = options.createAdapter ?? createChannelAdapterFactory(options);

  function bridgeAgent(id: string): void {
    gateway.registerAgent(id, createAgentBridge(id, options));
  }

  function bridgeRoutes(channel: RegisteredChannel): void {
    for (const rule of channel.routing) {
      // Agent deletion can race with adapter startup; never install a new
      // bridge for a reference that disappeared while starting the adapter.
      if (agentRegistry.get(rule.agentId)) bridgeAgent(rule.agentId);
    }
  }

  function requireChannel(name: string): RegisteredChannel {
    const entry = channelRegistry.get(name);
    if (!entry) throw new ChannelServiceError('not_found', 'not found');
    return entry;
  }

  function validateRouting(routing: ChannelRoutingRule[]): void {
    const missing = routing.map((rule) => rule.agentId).filter((id) => !agentRegistry.get(id));
    if (missing.length > 0) {
      throw new ChannelServiceError(
        'invalid_config',
        `routing references unknown agent(s): ${[...new Set(missing)].join(', ')}`,
      );
    }
  }

  function validateArray(value: unknown, message: string): void {
    if (value !== undefined && !Array.isArray(value)) {
      throw new ChannelServiceError('invalid_config', message);
    }
  }

  return {
    bridgeAgent,

    async create(input) {
      if (!input.name || !input.adapter || !input.routing) {
        throw new ChannelServiceError(
          'invalid_config',
          'Missing required fields: name, adapter, routing',
        );
      }
      validateArray(input.allowedUsers, 'allowedUsers must be an array of strings');
      validateRouting(input.routing);
      if (channelRegistry.has(input.name)) {
        throw new ChannelServiceError('conflict', `Channel '${input.name}' already exists`);
      }

      // Routing and allowlists must exist before constructor/start can expose
      // the adapter to inbound messages. Any failed setup rolls this back.
      const channel = channelRegistry.register({
        name: input.name,
        adapter: input.adapter as ChannelConfig['adapter'],
        routing: input.routing,
        globalDenyList: input.globalDenyList ?? [],
        allowedUsers: input.allowedUsers ?? [],
      });
      try {
        const adapter = await createAdapter(channel, 'create');
        await gateway.registerChannel(channel.name, adapter, channel);
        bridgeRoutes(channel);
        await channelRegistry.save();
        eventBus?.emit({ type: 'channel:created', channel: channel.name });
      } catch (error) {
        // A remove followed by a new create may reuse this name while the
        // factory or startup is pending. Only roll back the entry we own,
        // checking again after asynchronous shutdown before removing it.
        if (channelRegistry.get(channel.name) === channel) {
          await gateway.stopChannel(channel.name).catch(() => {});
          if (channelRegistry.get(channel.name) === channel) {
            channelRegistry.remove(channel.name);
          }
        }
        if (error instanceof ChannelAdapterConfigurationError) {
          throw new ChannelServiceError('invalid_config', error.message);
        }
        throw error;
      }
    },

    async update(name, patch) {
      requireChannel(name);
      validateArray(patch.allowedUsers, 'allowedUsers must be an array of strings');
      validateArray(patch.globalDenyList, 'globalDenyList must be an array of strings');
      validateArray(patch.routing, 'routing must be an array of rules');
      if (patch.routing !== undefined) validateRouting(patch.routing);
      const updated = channelRegistry.update(name, patch);
      await channelRegistry.save();
      eventBus?.emit({ type: 'channel:config-changed', channel: name, fields: Object.keys(patch) });
      return updated;
    },

    async remove(name) {
      requireChannel(name);
      // Keep live routing available until the adapter has stopped admitting
      // messages, then persist removal before notifying subscribers.
      await gateway.stopChannel(name);
      channelRegistry.remove(name);
      await channelRegistry.save();
      eventBus?.emit({ type: 'channel:removed', channel: name });
    },

    async restoreAll() {
      for (const channel of channelRegistry.list()) {
        try {
          const adapter = await createAdapter(channel, 'restore');
          await gateway.registerChannel(channel.name, adapter, channel);
          bridgeRoutes(channel);
          logger.info('channel restored', { channel: channel.name, adapter: channel.adapter });
        } catch (error) {
          logger.warn('channel restore failed', failureContext(error, channel.name));
        }
      }
    },

    async restartForCredential(key) {
      const match = key.match(/^channel:(.+):token$/);
      if (!match) return;
      const name = match[1];
      const channel = channelRegistry.get(name);
      if (!channel || channel.adapter !== 'telegram') return;

      // A credential save already succeeded. All subsequent work, including
      // rereading the credential, must remain best effort for its caller.
      try {
        if (!(await credentialStore.get(key))) return;
        await gateway.stopChannel(name);
        const adapter = await createAdapter(channel, 'restart');
        await gateway.registerChannel(name, adapter, channel);
        bridgeRoutes(channel);
        eventBus?.emit({ type: 'channel:restarted', channel: name, reason: 'token-rotation' });
        logger.info('channel restarted after token rotation', {
          channel: name,
          reason: 'token-rotation',
        });
      } catch (error) {
        logger.error(
          'channel token-rotation restart failed',
          undefined,
          failureContext(error, name),
        );
      }
    },
  };
}
