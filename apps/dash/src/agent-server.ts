import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashAgent, FileLogger, LocalAgentClient, PiAgentBackend } from '@dash/agent';
import type { AgentClient } from '@dash/agent';
import { startChatServer } from '@dash/chat';
import { startManagementServer } from '@dash/management';
import type { InfoResponse } from '@dash/management';
import { resolveAgentKeys } from './config.js';
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
  const backends: PiAgentBackend[] = [];
  const backendsByName = new Map<string, PiAgentBackend>();
  const agentsByName = new Map<string, DashAgent>();

  const failed: string[] = [];

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    try {
      let workspace: string | undefined;
      if (agentConfig.workspace) {
        workspace = resolve(projectRoot, agentConfig.workspace);
        await mkdir(workspace, { recursive: true });
      }

      const agentKeys = resolveAgentKeys(config.providerApiKeys, agentConfig.credentialKeys);
      for (const [provider, key] of Object.entries(agentKeys)) {
        const prefix = key.slice(0, 6);
        const suffix = key.slice(-10);
        log(`Agent "${name}" resolved key for provider "${provider}": ${prefix}***${suffix}`);
      }

      const backend = new PiAgentBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          tools: agentConfig.tools,
          workspace,
        },
        agentKeys,
        logger,
      );

      await backend.start(workspace ?? projectRoot);
      backends.push(backend);
      backendsByName.set(name, backend);

      const agent = new DashAgent(backend, {
        model: agentConfig.model,
        fallbackModels: agentConfig.fallbackModels,
        systemPrompt: agentConfig.systemPrompt,
        tools: agentConfig.tools,
        workspace,
      });

      agentsByName.set(name, agent);
      clients.set(name, new LocalAgentClient(agent));
      log(
        `Agent "${name}" started (model: ${agentConfig.model}, tools: ${agentConfig.tools?.join(', ') ?? 'all'}, workspace: ${workspace ?? 'unrestricted'})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[error] Agent "${name}" failed to start: ${msg}`);
      failed.push(name);
    }
  }

  if (failed.length === Object.keys(config.agents).length) {
    throw new Error(`All agents failed to start: ${failed.join(', ')}`);
  }
  if (failed.length > 0) {
    log(`[warn] ${failed.length} agent(s) skipped due to startup failure: ${failed.join(', ')}`);
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
          onUpdateCredentials: async (providerApiKeys) => {
            config.providerApiKeys = providerApiKeys;
            const providers = Object.keys(providerApiKeys);
            const keyCount = providers.reduce(
              (sum, p) => sum + Object.keys(providerApiKeys[p]).length,
              0,
            );
            log(
              `Credentials update received via Management API: ${keyCount} key(s) across [${providers.join(', ')}]`,
            );
            for (const [provider, keys] of Object.entries(providerApiKeys)) {
              for (const [keyName, value] of Object.entries(keys)) {
                const prefix = value.slice(0, 6);
                const suffix = value.slice(-3);
                log(`  Provider "${provider}" key "${keyName}": ${prefix}***${suffix}`);
              }
            }
            for (const [name, agentConfig] of Object.entries(config.agents)) {
              const backend = backendsByName.get(name);
              if (!backend) {
                log(`  Skipping agent "${name}": no backend found`);
                continue;
              }
              const agentKeys = resolveAgentKeys(providerApiKeys, agentConfig.credentialKeys);
              log(`  Pushing resolved keys to agent "${name}"`);
              await backend.updateCredentials(agentKeys);
            }
            log('Credentials update complete');
          },
          onUpdateAgentConfig: async (agentName, patch) => {
            const agent = agentsByName.get(agentName);
            if (!agent) throw new Error(`Agent "${agentName}" not found`);

            agent.updateConfig(patch);

            // Also update the in-memory config so /info reflects the change
            const agentConfig = config.agents[agentName];
            if (agentConfig) {
              if (patch.model !== undefined) agentConfig.model = patch.model;
              if (patch.fallbackModels !== undefined)
                agentConfig.fallbackModels = patch.fallbackModels;
              if (patch.tools !== undefined) agentConfig.tools = patch.tools;
              if (patch.systemPrompt !== undefined) agentConfig.systemPrompt = patch.systemPrompt;
            }

            const changes = Object.entries(patch)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
              .join(', ');
            log(`Agent "${agentName}" config updated: ${changes}`);
          },
        });
        managementClose = close;
        log(`Management API listening on port ${config.managementPort}`);
      }

      if (config.chatToken) {
        const { close } = startChatServer({
          port: config.chatPort,
          token: config.chatToken,
          agents: clients,
          logger,
        });
        chatClose = close;
        log(`Chat API listening on port ${config.chatPort}`);
      }

      log('Server ready');
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
