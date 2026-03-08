import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashAgent, FileLogger, LocalAgentClient, OpenCodeBackend } from '@dash/agent';
import type { AgentClient } from '@dash/agent';
import { startChatServer } from '@dash/chat';
import { startManagementServer } from '@dash/management';
import type { InfoResponse } from '@dash/management';
import type { DashConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

export async function createAgentServer(config: DashConfig) {
  let logger: FileLogger | undefined;
  if (config.logDir) {
    logger = await FileLogger.create(config.logDir, 'agent.log');
  }

  const log = (message: string): void => {
    console.log(message);
    logger?.info(message);
  };

  const clients = new Map<string, AgentClient>();
  const backends: OpenCodeBackend[] = [];

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    let workspace: string | undefined;
    if (agentConfig.workspace) {
      workspace = resolve(projectRoot, agentConfig.workspace);
      await mkdir(workspace, { recursive: true });
    }

    const backend = new OpenCodeBackend(
      {
        model: agentConfig.model,
        systemPrompt: agentConfig.systemPrompt,
        tools: agentConfig.tools,
        workspace,
        skills: agentConfig.skills,
      },
      config.providerApiKeys,
    );

    await backend.start(workspace ?? projectRoot);
    backends.push(backend);

    const agent = new DashAgent(backend, {
      model: agentConfig.model,
      systemPrompt: agentConfig.systemPrompt,
      tools: agentConfig.tools,
      workspace,
    });

    clients.set(name, new LocalAgentClient(agent));
    log(
      `Agent "${name}" started (model: ${agentConfig.model}, tools: ${agentConfig.tools?.join(', ') ?? 'all'}, workspace: ${workspace ?? 'unrestricted'})`,
    );
  }

  let managementClose: (() => Promise<void>) | undefined;
  let chatClose: (() => Promise<void>) | undefined;

  return {
    async start() {
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
            for (const backend of backends) await backend.stop();
            log('Dash agent server stopped via management API');
            if (logger) await logger.close();
            process.exit(0);
          },
          logFilePath: config.logDir ? resolve(config.logDir, 'agent.log') : undefined,
        });
        managementClose = close;
        log(`Management API listening on port ${config.managementPort}`);
      }

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
      for (const backend of backends) await backend.stop();
      log('Dash agent server stopped');
      if (logger) await logger.close();
    },
  };
}
