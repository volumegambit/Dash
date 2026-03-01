import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashAgent, JsonlSessionStore, NativeBackend, resolveTools } from '@dash/agent';
import { MessageRouter, TelegramAdapter } from '@dash/channels';
import { AnthropicProvider, ProviderRegistry } from '@dash/llm';
import type { DashConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

export async function createGateway(config: DashConfig) {
  // LLM
  const registry = new ProviderRegistry();
  registry.register(new AnthropicProvider(config.anthropicApiKey));

  // Create agents from config
  const agents = new Map<string, DashAgent>();
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
    console.log(
      `Agent "${name}" created (model: ${agentConfig.model}, tools: ${agentConfig.tools?.join(', ') ?? 'none'}, workspace: ${workspace ?? 'unrestricted'})`,
    );
  }

  // Channels
  const router = new MessageRouter(agents);

  for (const [name, channelConfig] of Object.entries(config.channels)) {
    if (name === 'telegram') {
      const telegram = new TelegramAdapter(
        config.telegramBotToken,
        channelConfig.allowedUsers ?? [],
      );
      router.addAdapter(telegram, channelConfig.agent);
    }
  }

  return {
    router,
    async start() {
      await router.startAll();
      console.log('Dash gateway started');
    },
    async stop() {
      await router.stopAll();
      console.log('Dash gateway stopped');
    },
  };
}
