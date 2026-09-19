import type { AgentChatCoordinator, AgentChatCoordinatorStats } from '../agent-chat-coordinator.js';
import type { ExecutionCoordinator, ExecutionStatus } from '../execution-coordinator.js';
import type { DynamicGateway } from '../gateway.js';
import type { RelayClient, RelayClientStatus } from '../relay-client.js';

export interface GatewayRuntimeStatus {
  execution: ExecutionStatus;
  pool: AgentChatCoordinatorStats;
  channels: ReturnType<DynamicGateway['channelHealth']>;
  relay: RelayClientStatus | { connection: 'disabled'; activeStreams: 0 };
}

export interface RuntimeStatusReaderOptions {
  execution: Pick<ExecutionCoordinator, 'status'>;
  agents: Pick<AgentChatCoordinator, 'stats'>;
  gateway: Pick<DynamicGateway, 'channelHealth'>;
  /** Relay startup is later than transport assembly, so read the current handle. */
  getRelayClient?: () => Pick<RelayClient, 'status'> | undefined;
}

/** A current diagnostic snapshot, with no configuration or credential objects. */
export function createRuntimeStatusReader(
  options: RuntimeStatusReaderOptions,
): () => GatewayRuntimeStatus {
  return () => {
    const execution = options.execution.status();
    const pool = options.agents.stats();
    const relay = options.getRelayClient?.()?.status();
    // Explicit projection keeps future internal fields out of the admin API.
    return {
      execution: {
        accepting: execution.accepting,
        activeCanonicalTurns: execution.activeCanonicalTurns,
        activeLegacyTurns: execution.activeLegacyTurns,
        quiescingAgents: execution.quiescingAgents,
      },
      pool: {
        size: pool.size,
        maxSize: pool.maxSize,
        pinned: pool.pinned,
        agents: { ...pool.agents },
      },
      channels: options.gateway.channelHealth().map(({ name, health }) => ({ name, health })),
      relay: relay
        ? { connection: relay.connection, activeStreams: relay.activeStreams }
        : { connection: 'disabled', activeStreams: 0 },
    };
  };
}
