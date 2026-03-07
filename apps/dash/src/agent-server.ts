import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DashAgent,
  FileLogger,
  JsonlSessionStore,
  LocalAgentClient,
  NativeBackend,
  resolveTools,
} from '@dash/agent';
import type { AgentClient } from '@dash/agent';
import { startChatServer } from '@dash/chat';
import { AnthropicProvider, GoogleProvider, OpenAIProvider, ProviderRegistry } from '@dash/llm';
import { startManagementServer } from '@dash/management';
import type { InfoResponse } from '@dash/management';
import type { DashConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

export async function createAgentServer(config: DashConfig) {
  // LLM
  const registry = new ProviderRegistry();
  registry.register(new AnthropicProvider(config.anthropicApiKey));
  if (config.googleApiKey) {
    registry.register(new GoogleProvider(config.googleApiKey));
  }
  if (config.openaiApiKey) {
    registry.register(new OpenAIProvider(config.openaiApiKey));
  }

  // Initialize file logger if logDir is configured
  let logger: FileLogger | undefined;
  if (config.logDir) {
    logger = await FileLogger.create(config.logDir, 'agent.log');
  }

  const log = (message: string): void => {
    console.log(message);
    logger?.info(message);
  };

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
    log(
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
            log('Dash agent server stopped via management API');
            if (logger) await logger.close();
            process.exit(0);
          },
          logFilePath: config.logDir ? resolve(config.logDir, 'agent.log') : undefined,
        });
        managementClose = close;
        log(`Management API listening on port ${config.managementPort}`);
      }

      // Chat server
      if (config.chatToken) {
        const { close } = startChatServer({
          port: config.chatPort,
          token: config.chatToken,
          agents: clients,
        });
        chatClose = close;
        log(`Chat API listening on port ${config.chatPort}`);
      }

      log('Dash agent server started');
    },
    async stop() {
      if (chatClose) await chatClose();
      if (managementClose) await managementClose();
      log('Dash agent server stopped');
      if (logger) await logger.close();
    },
  };
}
