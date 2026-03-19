import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileLogger, PooledAgentClient, generateFrontmatter } from '@dash/agent';
import type { AgentClient } from '@dash/agent';
import { startChatServer } from '@dash/chat';
import { startManagementServer } from '@dash/management';
import type { InfoResponse, SkillsHandlers } from '@dash/management';
import { loadSkillsFromDir } from '@mariozechner/pi-coding-agent';
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
  const pooledClients = new Map<string, PooledAgentClient>();

  const sessionBaseDir = config.configDir
    ? join(config.configDir, 'data', 'sessions')
    : join(projectRoot, 'data', 'sessions');

  for (const [name, agentConfig] of Object.entries(config.agents)) {
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

    const client = new PooledAgentClient(
      name,
      {
        model: agentConfig.model,
        fallbackModels: agentConfig.fallbackModels,
        systemPrompt: agentConfig.systemPrompt,
        tools: agentConfig.tools,
        workspace,
        skills: agentConfig.skills,
      },
      agentKeys,
      join(sessionBaseDir, name),
      workspace ?? projectRoot,
      logger,
    );
    pooledClients.set(name, client);
    clients.set(name, client);
    log(
      `Agent "${name}" registered (model: ${agentConfig.model}, tools: ${agentConfig.tools?.join(', ') ?? 'all'}, workspace: ${workspace ?? 'unrestricted'})`,
    );
  }

  const skillsHandlers: SkillsHandlers | undefined = config.managementToken
    ? {
        async list(agentName) {
          const paths = config.agents[agentName]?.skills?.paths ?? [];
          const allSkills = [];
          for (const p of paths) {
            const { skills } = loadSkillsFromDir({ dir: expandHome(p), source: 'path' });
            allSkills.push(...skills);
          }
          return allSkills.map((s) => ({
            name: s.name,
            description: s.description,
            location: s.location,
            editable: !s.location.startsWith('http'),
            source: s.source,
          }));
        },

        async get(agentName, skillName) {
          const paths = config.agents[agentName]?.skills?.paths ?? [];
          const allSkills = [];
          for (const p of paths) {
            const { skills } = loadSkillsFromDir({ dir: expandHome(p), source: 'path' });
            allSkills.push(...skills);
          }
          const found = allSkills.find((s) => s.name === skillName);
          if (!found) return null;
          const content = await readFile(found.filePath, 'utf-8');
          return {
            name: found.name,
            description: found.description,
            location: found.filePath,
            editable: !found.filePath.startsWith('http'),
            content,
          };
        },

        async updateContent(agentName, skillName, content) {
          const paths = config.agents[agentName]?.skills?.paths ?? [];
          const allSkills = [];
          for (const p of paths) {
            const { skills } = loadSkillsFromDir({ dir: expandHome(p), source: 'path' });
            allSkills.push(...skills);
          }
          const found = allSkills.find((s) => s.name === skillName);
          if (!found) throw new Error(`Skill "${skillName}" not found`);
          if (found.filePath.startsWith('http'))
            throw new Error('Skill is remote and not editable');
          const resolvedLocation = resolve(found.filePath);
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
          // Prefer managed dir, fall back to first configured path
          const managedDir = config.configDir
            ? join(resolve(config.configDir, '..'), 'skills', agentName)
            : null;
          const paths = config.agents[agentName]?.skills?.paths ?? [];
          const targetDir = managedDir ?? (paths.length > 0 ? expandHome(paths[0]) : null);
          if (!targetDir) throw new Error('No writable skill path configured for this agent');

          const safeSkillName = basename(skillName);
          if (!safeSkillName || safeSkillName === '.' || safeSkillName === '..') {
            throw new Error('Invalid skill name');
          }
          const skillDir = join(targetDir, safeSkillName);
          await mkdir(skillDir, { recursive: true });
          const skillFile = join(skillDir, 'SKILL.md');
          const fullContent = generateFrontmatter({ name: safeSkillName, description }, content);
          await writeFile(skillFile, fullContent, 'utf-8');
          return {
            name: safeSkillName,
            description,
            location: skillFile,
            editable: true,
            source: 'managed' as const,
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
            for (const client of pooledClients.values()) await client.stop();
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
              const client = pooledClients.get(name);
              if (!client) {
                log(`  Skipping agent "${name}": no client found`);
                continue;
              }
              const agentKeys = resolveAgentKeys(providerApiKeys, agentConfig.credentialKeys);
              log(`  Pushing resolved keys to agent "${name}"`);
              await client.updateCredentials(agentKeys);
            }
            log('Credentials update complete');
          },
          onUpdateAgentConfig: async (agentName, patch) => {
            const client = pooledClients.get(agentName);
            if (!client) throw new Error(`Agent "${agentName}" not found`);

            client.updateConfig(patch);

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
      for (const client of pooledClients.values()) await client.stop();
      log('Dash agent server stopped');
      if (logger) await logger.close();
    },
  };
}
