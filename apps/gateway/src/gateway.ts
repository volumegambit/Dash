import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter, InboundMessage, MessageLogEntry } from '@dash/channels';

interface RoutingRule {
  globalDenyList: string[];
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentId: string;
  allowList: string[];
  denyList: string[];
}

interface ChannelState {
  adapter: ChannelAdapter;
  rules: RoutingRule[];
}

/**
 * Live routing resolver — when provided, handleMessage reads fresh routing
 * config from this function on every inbound message instead of using the
 * static rules captured at `registerChannel` time. This lets runtime edits
 * (e.g. `PUT /channels/:name`) take effect on the next message with no
 * reconciliation step. Return `null` to signal the channel has been removed
 * from the registry; the message will be dropped and logged as
 * `channel_removed` while the adapter keeps running (separate shutdown path).
 */
export type RoutingResolver = (channelName: string) => {
  globalDenyList: string[];
  routing: Array<{
    condition: RoutingRule['condition'];
    agentId: string;
    allowList: string[];
    denyList: string[];
  }>;
} | null;

export interface DynamicGatewayOptions {
  dataDir?: string;
  resolveRouting?: RoutingResolver;
}

export interface DynamicGateway {
  registerAgent(agentId: string, client: AgentClient): void;
  deregisterAgent(agentId: string): Promise<string[]>;
  registerChannel(
    channelName: string,
    adapter: ChannelAdapter,
    config: {
      globalDenyList: string[];
      routing: Array<{
        condition: RoutingRule['condition'];
        agentId: string;
        allowList: string[];
        denyList: string[];
      }>;
    },
  ): Promise<void>;
  /**
   * Stop the adapter for a channel and remove it from the running gateway.
   * Returns `true` if the channel was running and has been stopped; `false`
   * if no such channel was registered. Safe to call even if the channel
   * has already been removed from `channelRegistry` — the gateway's
   * channel map is independent of the registry.
   */
  stopChannel(channelName: string): Promise<boolean>;
  agentCount(): number;
  channelCount(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDynamicGateway(options?: DynamicGatewayOptions): DynamicGateway {
  const agents = new Map<string, AgentClient>();
  const channels = new Map<string, ChannelState>();
  const resolveRouting = options?.resolveRouting;

  // Set up channel message logging
  let logDir: string | null = null;
  if (options?.dataDir) {
    logDir = join(options.dataDir, 'channel-logs');
    mkdirSync(logDir, { recursive: true });
  }

  function logMessage(entry: MessageLogEntry): void {
    if (!logDir) return;
    try {
      const logPath = join(logDir, `${entry.channelName}.jsonl`);
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      // Don't let logging failures break message handling — but do NOT
      // swallow them silently. A persistent failure here means the audit
      // trail is gone, which is exactly the kind of thing you want to
      // know about without ssh'ing into the box.
      console.warn(
        `[gateway] channel log write failed channel=${entry.channelName}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  function materializeRules(
    channelName: string,
    fallback: RoutingRule[],
  ): { rules: RoutingRule[] | null; removed: boolean } {
    if (!resolveRouting) return { rules: fallback, removed: false };
    const live = resolveRouting(channelName);
    if (!live) return { rules: null, removed: true };
    const rules: RoutingRule[] = live.routing.map((r) => ({
      globalDenyList: live.globalDenyList,
      condition: r.condition,
      agentId: r.agentId,
      allowList: r.allowList,
      denyList: r.denyList,
    }));
    return { rules, removed: false };
  }

  async function handleMessage(
    channelName: string,
    msg: InboundMessage,
    adapter: ChannelAdapter,
  ): Promise<void> {
    const state = channels.get(channelName);
    if (!state) return;

    const baseLog: Omit<MessageLogEntry, 'outcome' | 'agentName' | 'blockReason'> = {
      timestamp: new Date().toISOString(),
      channelName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      conversationId: msg.conversationId,
      text: msg.text,
    };

    // Top-level try/catch so one bad message never escapes into the
    // adapter middleware and misreports as a transport failure.
    try {
      // Resolve routing — prefer the live resolver (pulls from the
      // persisted channel registry on every call) and fall back to the
      // static copy stamped at registerChannel time.
      const { rules, removed } = materializeRules(channelName, state.rules);
      if (removed) {
        console.warn(
          `[gateway] dropping message: channel "${channelName}" no longer in registry (removed without adapter shutdown)`,
        );
        logMessage({ ...baseLog, outcome: 'blocked', blockReason: 'channel_removed' });
        return;
      }
      if (!rules) return;

      const matched = rules.find((rule) => {
        if (rule.globalDenyList.includes(msg.senderId)) return false;
        switch (rule.condition.type) {
          case 'default':
            return true;
          case 'sender':
            return rule.condition.ids.includes(msg.senderId);
          case 'group':
            return rule.condition.ids.includes(msg.conversationId);
        }
      });
      if (!matched) {
        logMessage({ ...baseLog, outcome: 'no_match' });
        return;
      }

      const agentName = matched.agentId;

      if (matched.denyList.includes(msg.senderId)) {
        logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'rule_deny' });
        return;
      }
      if (matched.allowList.length > 0 && !matched.allowList.includes(msg.senderId)) {
        logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'not_on_allow_list' });
        return;
      }

      const agent = agents.get(matched.agentId);
      if (!agent) {
        console.warn(`[gateway] dropped message: agent "${matched.agentId}" not found`);
        logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'agent_not_found' });
        return;
      }

      logMessage({ ...baseLog, outcome: 'routed', agentName });

      const prefixedConvId = `${channelName}:${msg.conversationId}`;

      let fullResponse = '';
      let streamError: Error | null = null;
      try {
        for await (const event of agent.chat(msg.channelId, prefixedConvId, msg.text)) {
          if (event.type === 'response') {
            fullResponse = event.content;
          } else if (event.type === 'error') {
            // Error-as-data path (preferred): the generator yields a
            // structured error event and continues. We still log it so
            // there's a server-side record — the old code only showed
            // it to the user.
            streamError = event.error;
            console.error(
              `[gateway] agent "${matched.agentId}" yielded error channel=${channelName} conversationId=${msg.conversationId}:`,
              event.error instanceof Error
                ? (event.error.stack ?? event.error.message)
                : event.error,
            );
            fullResponse = `Error: ${event.error.message}`;
          }
        }
      } catch (err) {
        // Exception-from-generator path: the agent backend threw instead
        // of yielding. Treat as an internal error, record it, and send a
        // sanitized reply so the user isn't left hanging.
        streamError = err instanceof Error ? err : new Error(String(err));
        console.error(
          `[gateway] agent "${matched.agentId}" stream threw channel=${channelName} conversationId=${msg.conversationId}:`,
          streamError.stack ?? streamError.message,
        );
        fullResponse = 'Error: internal agent failure (see gateway logs)';
      }

      if (streamError) {
        // Additional structured audit entry alongside the 'routed' entry
        // above — gives log readers a single place to grep for agent
        // stream failures without parsing reply text.
        logMessage({
          ...baseLog,
          outcome: 'blocked',
          agentName,
          blockReason: `agent_stream_error: ${streamError.message}`,
        });
      }

      if (fullResponse) {
        try {
          await adapter.send(msg.conversationId, { text: fullResponse });
        } catch (err) {
          // Delivery failed — the routing bookkeeping said 'routed' but
          // the user will never see it. Record the discrepancy so the
          // audit log reflects reality.
          console.error(
            `[gateway] adapter.send failed channel=${channelName} conversationId=${msg.conversationId}:`,
            err instanceof Error ? (err.stack ?? err.message) : err,
          );
          logMessage({
            ...baseLog,
            outcome: 'blocked',
            agentName,
            blockReason: `send_failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } catch (err) {
      // Anything unexpected (rule-match callback throwing, logMessage
      // re-throwing, etc.). Do NOT re-throw — this function is called
      // from inside the adapter's message middleware and rethrowing
      // would be misreported as a transport error.
      console.error(
        `[gateway] handleMessage crashed channel=${channelName} senderId=${msg.senderId} conversationId=${msg.conversationId}:`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      try {
        logMessage({
          ...baseLog,
          outcome: 'blocked',
          blockReason: `handler_crash: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        // logMessage already does its own warn on failure — if it still
        // throws (it shouldn't, we catch inside), we've done our best.
      }
    }
  }

  return {
    registerAgent(agentId, client) {
      agents.set(agentId, client);
    },

    async deregisterAgent(agentId) {
      agents.delete(agentId);

      const removedChannels: string[] = [];
      const toStop: ChannelAdapter[] = [];
      for (const [name, state] of [...channels.entries()]) {
        state.rules = state.rules.filter((r) => r.agentId !== agentId);
        if (state.rules.length === 0) {
          toStop.push(state.adapter);
          channels.delete(name);
          removedChannels.push(name);
        }
      }
      await Promise.all(toStop.map((a) => a.stop()));
      return removedChannels;
    },

    async registerChannel(channelName, adapter, config) {
      const newRules: RoutingRule[] = config.routing.map((r) => ({
        globalDenyList: config.globalDenyList ?? [],
        condition: r.condition,
        agentId: r.agentId,
        allowList: r.allowList,
        denyList: r.denyList,
      }));

      const existing = channels.get(channelName);
      if (existing) {
        existing.rules = [...existing.rules, ...newRules];
      } else {
        const state: ChannelState = {
          adapter,
          rules: newRules,
        };
        channels.set(channelName, state);
        adapter.onMessage(async (msg) => {
          await handleMessage(channelName, msg, adapter);
        });
        await adapter.start();
      }
    },

    async stopChannel(channelName) {
      const state = channels.get(channelName);
      if (!state) return false;
      channels.delete(channelName);
      try {
        await state.adapter.stop();
      } catch (err) {
        // Don't rethrow — the channel is out of the gateway's routing
        // tables and cannot receive new messages, which is what callers
        // care about. A stop() that threw still counts as "stopped" from
        // the routing perspective; log so operators can diagnose.
        console.warn(
          `[gateway] stopChannel: adapter.stop() threw for channel="${channelName}":`,
          err instanceof Error ? err.message : err,
        );
      }
      return true;
    },

    agentCount: () => agents.size,
    channelCount: () => channels.size,

    async start() {
      // no-op: adapters are started on registerChannel
    },

    async stop() {
      await Promise.all([...channels.values()].map((s) => s.adapter.stop()));
      channels.clear();
      agents.clear();
    },
  };
}
