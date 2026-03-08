import type { AgentClient } from '@dash/agent';
import {
  MessageRouter,
  MissionControlAdapter,
  TelegramAdapter,
  WhatsAppAdapter,
} from '@dash/channels';
import type { ChannelAdapter, RouterConfig } from '@dash/channels';
import { RemoteAgentClient } from '@dash/chat';
import type { GatewayConfig } from './config.js';

function createNonMcAdapter(
  name: string,
  config: GatewayConfig['channels'][string],
): ChannelAdapter {
  switch (config.adapter) {
    case 'telegram': {
      if (!config.token) {
        throw new Error(`Channel "${name}" (telegram) requires a "token" field.`);
      }
      // In routing-rules mode, allowedUsers is not used (filtering is in MessageRouter)
      return new TelegramAdapter(config.token, config.routing ? [] : (config.allowedUsers ?? []));
    }
    case 'whatsapp': {
      const authStateDir = config.authStateDir;
      if (!authStateDir) {
        throw new Error(`Channel "${name}" (whatsapp) requires an "authStateDir" field.`);
      }
      return new WhatsAppAdapter(config.whatsappAuth ?? {}, authStateDir);
    }
    default:
      throw new Error(`Unknown adapter type "${config.adapter}" for channel "${name}".`);
  }
}

export function createGateway(config: GatewayConfig) {
  const agents = new Map<string, AgentClient>();
  for (const [name, endpoint] of Object.entries(config.agents)) {
    agents.set(name, new RemoteAgentClient(endpoint.url, endpoint.token, name));
    console.log(`Agent "${name}" configured (url: ${endpoint.url})`);
  }

  const router = new MessageRouter(agents);
  const mcAdapters: MissionControlAdapter[] = [];

  for (const [name, channelConfig] of Object.entries(config.channels)) {
    if (channelConfig.adapter === 'mission-control') {
      const port = channelConfig.port ?? 9200;
      mcAdapters.push(new MissionControlAdapter(port, agents, channelConfig.token));
      console.log(`Channel "${name}" (mission-control) on port ${port}`);
    } else {
      const adapter = createNonMcAdapter(name, channelConfig);

      if (channelConfig.routing) {
        // Advanced routing-rules mode
        const routerConfig: RouterConfig = {
          globalDenyList: channelConfig.globalDenyList ?? [],
          rules: channelConfig.routing.map((r) => ({
            condition: r.condition,
            agentName: r.agentName,
            allowList: r.allowList,
            denyList: r.denyList,
          })),
        };
        router.addAdapter(adapter, routerConfig);
        console.log(
          `Channel "${name}" (${channelConfig.adapter}) → routing rules (${routerConfig.rules.length} rules)`,
        );
      } else {
        // Simple mode
        const agentName = channelConfig.agent;
        if (!agentName) throw new Error(`Channel "${name}" requires an "agent" field.`);
        router.addAdapter(adapter, agentName);
        console.log(`Channel "${name}" (${channelConfig.adapter}) → agent "${agentName}"`);
      }
    }
  }

  return {
    async start() {
      await router.startAll();
      await Promise.all(mcAdapters.map((a) => a.start()));
      console.log('Gateway started');
    },
    async stop() {
      await router.stopAll();
      await Promise.all(mcAdapters.map((a) => a.stop()));
      console.log('Gateway stopped');
    },
  };
}
