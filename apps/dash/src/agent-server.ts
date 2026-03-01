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
import { AnthropicProvider, ProviderRegistry } from '@dash/llm';
import { startChatServer, startManagementServer } from '@dash/management';
import type { InfoResponse } from '@dash/management';
import type { DashConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

export async function createAgentServer(config: DashConfig) {
  // LLM
  const registry = new ProviderRegistry();
  registry.register(new AnthropicProvider(config.anthropicApiKey));

  // Create agents from config
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

    clients.set(name, new LocalAgentClient(agent));
    console.log(
      `Agent "${name}" created (model: ${agentConfig.model}, tools: ${agentConfig.tools?.join(', ') ?? 'none'}, workspace: ${workspace ?? 'unrestricted'})`,
    );
  }

  // Server close handles
  let managementClose: (() => Promise<void>) | undefined;
  let chatClose: (() => Promise<void>) | undefined;

  return {
    async start() {
      // Management server
      if (config.managementToken) {
        const getInfo = (): InfoResponse => ({
          agents: Object.entries(config.agents).map(([name, ac]) => ({
            name,
            model: ac.model,
            tools: ac.tools ?? [],
          })),
        });

        const { close } = startManagementServer({
          port: config.managementPort,
          token: config.managementToken,
          getInfo,
          onShutdown: async () => {
            if (chatClose) await chatClose();
            if (managementClose) await managementClose();
            console.log('Dash agent server stopped via management API');
            process.exit(0);
          },
        });
        managementClose = close;
        console.log(`Management API listening on port ${config.managementPort}`);
      }

      // Chat server
      if (config.chatToken) {
        const { close } = startChatServer({
          port: config.chatPort,
          token: config.chatToken,
          agents: clients,
        });
        chatClose = close;
        console.log(`Chat API listening on port ${config.chatPort}`);
      }

      console.log('Dash agent server started');
    },
    async stop() {
      if (chatClose) await chatClose();
      if (managementClose) await managementClose();
      console.log('Dash agent server stopped');
    },
  };
}
