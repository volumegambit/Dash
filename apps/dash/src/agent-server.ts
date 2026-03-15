import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashAgent, FileLogger, LocalAgentClient, OpenCodeBackend } from '@dash/agent';
import type { AgentClient } from '@dash/agent';
import { startChatServer } from '@dash/chat';
import { startManagementServer } from '@dash/management';
import type { InfoResponse, SkillsHandlers } from '@dash/management';
import { resolveAgentKeys } from './config.js';
import type { DashConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

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
  const backendsByName = new Map<string, OpenCodeBackend>();
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

      const backend = new OpenCodeBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          tools: agentConfig.tools,
          workspace,
          skills: agentConfig.skills,
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

  const skillsHandlers: SkillsHandlers | undefined = config.managementToken
    ? {
        async list(agentName) {
          const raw = (await backendsByName.get(agentName)?.listSkills()) ?? [];
          return raw.map((s) => ({
            name: s.name,
            description: s.description,
            location: s.location,
            editable: !s.location.startsWith('http'),
          }));
        },

        async get(agentName, skillName) {
          const raw = (await backendsByName.get(agentName)?.listSkills()) ?? [];
          const found = raw.find((s) => s.name === skillName);
          if (!found) return null;
          return {
            name: found.name,
            description: found.description,
            location: found.location,
            editable: !found.location.startsWith('http'),
            content: found.content,
          };
        },

        async updateContent(agentName, skillName, content) {
          const raw = (await backendsByName.get(agentName)?.listSkills()) ?? [];
          const found = raw.find((s) => s.name === skillName);
          if (!found) throw new Error(`Skill "${skillName}" not found`);
          if (found.location.startsWith('http'))
            throw new Error('Skill is remote and not editable');
          const resolvedLocation = resolve(found.location);
          const paths = config.agents[agentName]?.skills?.paths ?? [];
          const insideConfiguredPath = paths.some((p) => {
            const resolvedPath = resolve(expandHome(p));
            return (
              resolvedLocation === resolvedPath || resolvedLocation.startsWith(`${resolvedPath}/`)
            );
          });
          if (!insideConfiguredPath) {
            throw new Error('Skill location is outside configured skill paths');
          }
          await writeFile(resolvedLocation, content, 'utf-8');
        },

        async create(agentName, skillName, description, content) {
          const paths = config.agents[agentName]?.skills?.paths ?? [];
          if (paths.length === 0)
            throw new Error('No writable skill path configured for this agent');
          const safeSkillName = basename(skillName);
          if (!safeSkillName || safeSkillName === '.' || safeSkillName === '..') {
            throw new Error('Invalid skill name');
          }
          const skillDir = join(expandHome(paths[0]), safeSkillName);
          await mkdir(skillDir, { recursive: true });
          const skillFile = join(skillDir, 'SKILL.md');
          const fullContent = `---\nname: ${safeSkillName}\ndescription: ${description}\n---\n\n${content}`;
          await writeFile(skillFile, fullContent, 'utf-8');
          return {
            name: safeSkillName,
            description,
            location: skillFile,
            editable: true,
            content: fullContent,
          };
        },

        getConfig(agentName) {
          return {
            paths: config.agents[agentName]?.skills?.paths ?? [],
            urls: config.agents[agentName]?.skills?.urls ?? [],
          };
        },

        async updateConfig(agentName, skillsConfig) {
          if (!config.configDir) {
            throw new Error(
              'Config directory not available — agent was not started with --config <dir>',
            );
          }
          const dashJsonPath = join(config.configDir, 'dash.json');
          const raw = await readFile(dashJsonPath, 'utf-8');
          const json = JSON.parse(raw) as { agents?: Record<string, { skills?: unknown }> };
          if (!json.agents?.[agentName]) {
            throw new Error(`Agent '${agentName}' not found in config`);
          }
          json.agents[agentName].skills = skillsConfig;
          await writeFile(dashJsonPath, JSON.stringify(json, null, 2), 'utf-8');
        },
      }
    : undefined;

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
          skills: skillsHandlers,
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
