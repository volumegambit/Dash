import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DashAgent,
  JsonlSessionStore,
  LocalAgentClient,
  NativeBackend,
  resolveTools,
} from '@dash/agent';
import type { AgentClient } from '@dash/agent';
import { MessageRouter, TelegramAdapter } from '@dash/channels';
import { AnthropicProvider, ProviderRegistry } from '@dash/llm';
import { startManagementServer } from '@dash/management';
import type { InfoResponse } from '@dash/management';
import type { DashConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

export async function createGateway(config: DashConfig) {
  // LLM
  const registry = new ProviderRegistry();
  registry.register(new AnthropicProvider(config.anthropicApiKey));

  // Create agents from config
  const agents = new Map<string, DashAgent>();
  const clients = new Map<string, AgentClient>();
  const sessionStore = new JsonlSessionStore(config.sessionDir);

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const provider = registry.resolveProvider(agentConfig.model);
    const backend = new NativeBackend(provider);

    // Resolve workspace path and ensure directory exists
    let workspace: string | undefined;
    if (agentConfig.workspace) {
      workspace = resolve(projectRoot, agentConfig.workspace);
      await mkdir(workspace, { recursive: true });
    }

    const tools = agentConfig.tools ? resolveTools(agentConfig.tools, workspace) : undefined;

    const agent = new DashAgent(backend, sessionStore, {
      model: agentConfig.model,
      systemPrompt: agentConfig.systemPrompt,
      tools,
      maxTokens: agentConfig.maxTokens,
      thinking: agentConfig.thinking,
    });

    agents.set(name, agent);
    clients.set(name, new LocalAgentClient(agent));
    console.log(
      `Agent "${name}" created (model: ${agentConfig.model}, tools: ${agentConfig.tools?.join(', ') ?? 'none'}, workspace: ${workspace ?? 'unrestricted'})`,
    );
  }

  // Channels
  const router = new MessageRouter(clients);

  for (const [name, channelConfig] of Object.entries(config.channels)) {
    if (name === 'telegram') {
      const telegram = new TelegramAdapter(
        config.telegramBotToken,
        channelConfig.allowedUsers ?? [],
      );
      router.addAdapter(telegram, channelConfig.agent);
    }
  }

  // Management server
  let managementClose: (() => Promise<void>) | undefined;

  return {
    router,
    async start() {
      await router.startAll();

      if (config.managementToken) {
        const getInfo = (): InfoResponse => ({
          agents: Object.entries(config.agents).map(([name, ac]) => ({
            name,
            model: ac.model,
            tools: ac.tools ?? [],
          })),
          channels: Object.entries(config.channels).map(([name, cc]) => ({
            name,
            agent: cc.agent,
          })),
        });

        const { close } = startManagementServer({
          port: config.managementPort,
          token: config.managementToken,
          getInfo,
          onShutdown: async () => {
            await router.stopAll();
            if (managementClose) {
              await managementClose();
            }
            console.log('Dash gateway stopped via management API');
            process.exit(0);
          },
        });
        managementClose = close;
        console.log(`Management API listening on port ${config.managementPort}`);
      }

      console.log('Dash gateway started');
    },
    async stop() {
      await router.stopAll();
      if (managementClose) {
        await managementClose();
      }
      console.log('Dash gateway stopped');
    },
  };
}
