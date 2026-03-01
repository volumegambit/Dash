import type { AgentClient } from '@dash/agent';
import { MessageRouter, MissionControlAdapter, TelegramAdapter } from '@dash/channels';
import type { ChannelAdapter } from '@dash/channels';
import { RemoteAgentClient } from '@dash/chat';
import type { GatewayConfig } from './config.js';

function createAdapter(name: string, config: GatewayConfig['channels'][string]): ChannelAdapter {
  switch (config.adapter) {
    case 'telegram': {
      if (!config.token) {
        throw new Error(`Channel "${name}" (telegram) requires a "token" field.`);
      }
      return new TelegramAdapter(config.token, config.allowedUsers ?? []);
    }
    case 'mission-control': {
      const port = config.port ?? 9200;
      return new MissionControlAdapter(port);
    }
    default:
      throw new Error(`Unknown adapter type "${config.adapter}" for channel "${name}".`);
  }
}

export function createGateway(config: GatewayConfig) {
  // Create remote agent clients
  const agents = new Map<string, AgentClient>();
  for (const [name, endpoint] of Object.entries(config.agents)) {
    agents.set(name, new RemoteAgentClient(endpoint.url, endpoint.token, name));
    console.log(`Agent "${name}" configured (url: ${endpoint.url})`);
  }

  // Create router and adapters
  const router = new MessageRouter(agents);

  for (const [name, channelConfig] of Object.entries(config.channels)) {
    const adapter = createAdapter(name, channelConfig);
    router.addAdapter(adapter, channelConfig.agent);
    console.log(`Channel "${name}" (${channelConfig.adapter}) → agent "${channelConfig.agent}"`);
  }

  return {
    async start() {
      await router.startAll();
      console.log('Gateway started');
    },
    async stop() {
      await router.stopAll();
      console.log('Gateway stopped');
    },
  };
}
