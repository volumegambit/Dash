import type { ChannelHealth } from '@dash/channels';
import type { AgentChatCoordinatorStats } from '../agent-chat-coordinator.js';
import type { ExecutionStatus } from '../execution-coordinator.js';
import type { RelayClientStatus } from '../relay-client.js';
import { createRuntimeStatusReader } from './runtime-status.js';

describe('runtime status reader', () => {
  it('reads current owners and projects only diagnostic fields, including a late-bound relay', () => {
    let execution: ExecutionStatus = {
      accepting: true,
      activeCanonicalTurns: 2,
      activeLegacyTurns: 1,
      quiescingAgents: 0,
    };
    let pool: AgentChatCoordinatorStats = {
      size: 4,
      maxSize: 200,
      pinned: 3,
      agents: { agent: 4 },
    };
    let health: ChannelHealth = 'connecting';
    let relay: RelayClientStatus | undefined;
    const read = createRuntimeStatusReader({
      execution: { status: () => ({ ...execution, prompt: 'private input' }) },
      agents: { stats: () => ({ ...pool, apiKey: 'private key' }) },
      gateway: {
        channelHealth: () => [{ name: 'telegram', health, credential: 'private channel key' }],
      },
      getRelayClient: () => {
        const current = relay;
        return current
          ? { status: () => ({ ...current, relayUrl: 'wss://secret.example/?token=private' }) }
          : undefined;
      },
    });
    const first = read();
    expect(first).toEqual({
      execution,
      pool,
      channels: [{ name: 'telegram', health: 'connecting' }],
      relay: { connection: 'disabled', activeStreams: 0 },
    });
    execution = { ...execution, activeCanonicalTurns: 1, quiescingAgents: 1 };
    pool = { ...pool, pinned: 2 };
    health = 'connected';
    relay = { connection: 'connected', activeStreams: 3 };
    expect(read()).toEqual({
      execution,
      pool,
      channels: [{ name: 'telegram', health: 'connected' }],
      relay,
    });
    expect(first.execution.activeCanonicalTurns).toBe(2);
    expect(first.pool.pinned).toBe(3);
    expect(first.channels[0].health).toBe('connecting');
    expect(JSON.stringify(read())).not.toContain('private');
    relay = { connection: 'stopped', activeStreams: 0 };
    expect(read().relay).toEqual(relay);
  });

  it('reports an absent relay as disabled without requiring a getter', () => {
    const read = createRuntimeStatusReader({
      execution: {
        status: () => ({
          accepting: false,
          activeCanonicalTurns: 0,
          activeLegacyTurns: 0,
          quiescingAgents: 0,
        }),
      },
      agents: { stats: () => ({ size: 0, maxSize: 200, pinned: 0, agents: {} }) },
      gateway: { channelHealth: () => [] },
    });
    expect(read().relay).toEqual({ connection: 'disabled', activeStreams: 0 });
  });
});
