import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type ExtraTool,
  PiAgentBackend,
  type PiAgentBackendOptions,
  createGetLocationTool,
} from '@dash/agent';
import type { McpAgentContext, McpConfigStoreInterface, McpManager } from '@dash/mcp';
import { type ProjectsDb, createProjectsTools } from '@dash/projects';
import { type SwarmCoordinator, createStaticResolver } from '@dash/swarm';
import type { AgentChatCoordinatorOptions } from '../agent-chat-coordinator.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { GatewayCredentialStore } from '../credential-store.js';
import type { OAuthRefreshCoordinator } from '../oauth-refresh.js';
import { filterPluginsByAgent } from '../plugin-filtering.js';
import type { PluginWiringState } from '../plugins-wiring.js';
import { isSubagentsEnabled } from '../subagent-config.js';
import type { SubagentRosterRefresher } from '../subagent-roster-refresh.js';
import { createSubagentExtraTools, orchestratorMcpToolNames } from '../subagent-tools.js';

export interface RuntimeCredentialProviderOptions {
  credentialStore: Pick<GatewayCredentialStore, 'readProviderApiKeys'>;
  oauthRefreshCoordinator: Pick<OAuthRefreshCoordinator, 'refreshExpiring'>;
  getWiringState: () => Pick<PluginWiringState, 'pluginProviderConfigs'>;
}

/**
 * Shared by parent and restricted child runtimes. Each invocation refreshes
 * OAuth before reading the store, so rotation and deletion apply on the next
 * run. The live wiring already excludes provider-id collisions; placeholders
 * only fill missing keys and never replace a configured credential.
 */
export function createRuntimeCredentialProvider(
  options: RuntimeCredentialProviderOptions,
): () => Promise<Record<string, string>> {
  return async () => {
    await options.oauthRefreshCoordinator.refreshExpiring();
    const keys = await options.credentialStore.readProviderApiKeys();
    for (const { catalog } of options.getWiringState().pluginProviderConfigs) {
      if (catalog.placeholderKey && !keys[catalog.id]) {
        keys[catalog.id] = catalog.placeholderKey;
      }
    }
    return keys;
  };
}

export interface AgentRuntimeFactoryOptions {
  dataDir: string;
  registry: Pick<AgentRegistry, 'get' | 'findByName' | 'patchMcpServers' | 'list' | 'save'>;
  getWiringState: () => PluginWiringState;
  credentialProvider: () => Promise<Record<string, string>>;
  mcpManager: McpManager;
  mcpConfigStore: McpConfigStoreInterface;
  projectsDb: ProjectsDb;
  swarmCoordinator: SwarmCoordinator;
  subagentRosters: Pick<SubagentRosterRefresher, 'resolverFor'>;
  listMcpToolNames: () => string[];
  /** Named construction boundary; the default builds the production backend. */
  createBackend?: (options: PiAgentBackendOptions) => PiAgentBackend;
}

/**
 * Builds PARENT conversation runtimes. Child grants remain in subagent-wiring:
 * sharing this factory would grant a child the parent's writable skills, MCP
 * administration and projects tools.
 */
export function createAgentRuntimeFactory(
  options: AgentRuntimeFactoryOptions,
): AgentChatCoordinatorOptions['createBackend'] {
  const {
    dataDir,
    registry,
    credentialProvider,
    mcpManager,
    mcpConfigStore,
    projectsDb,
    swarmCoordinator,
    subagentRosters,
    listMcpToolNames,
  } = options;
  const createBackend = options.createBackend ?? PiAgentBackend.fromOptions;

  return async (agentConfig, conversationId, agentId) => {
    // Sessions and writable skills retain the agent-name layout. Memory was
    // resolved by the coordinator using the immutable registry id instead.
    const sessionDir = resolve(dataDir, 'sessions', agentConfig.name, conversationId);
    await mkdir(sessionDir, { recursive: true });

    const agentMcpServers = agentConfig.mcpServers ?? [];
    const mcpAgentContext: McpAgentContext = {
      async assignToAgent(serverName) {
        const entry = registry.findByName(agentConfig.name);
        if (!entry) return;
        registry.patchMcpServers(entry.id, 'add', serverName);
        await registry.save();
      },
      async unassignFromAgent(serverName) {
        const entry = registry.findByName(agentConfig.name);
        if (!entry) return false;
        registry.patchMcpServers(entry.id, 'remove', serverName);
        await registry.save();
        const stillUsed = registry
          .list()
          .some((a) => (a.config.mcpServers ?? []).includes(serverName));
        if (stillUsed) return false;
        try {
          await mcpManager.removeServer(serverName);
          await mcpConfigStore.removeConfig(serverName);
        } catch {
          /* already removed */
        }
        return true;
      },
      getAssignedServers() {
        const entry = registry.findByName(agentConfig.name);
        return entry?.config.mcpServers ?? agentMcpServers;
      },
    };

    // Snapshot at construction, after any plugin reload. Warm in-flight
    // backends retain their captured wiring until they drain. Selection only
    // narrows visible skills/commands; plugin trust was applied upstream.
    const wiring = options.getWiringState();
    const { skillDirs, commandFiles } = filterPluginsByAgent(
      agentConfig.plugins,
      wiring.skillDirs,
      wiring.commandFiles,
      wiring.skillDirsByPlugin,
      wiring.agentDefFiles,
    );
    // Definitions reach the roster, never extraSkillFiles. Disabled agents
    // avoid the asynchronous roster scan entirely.
    const resolver = isSubagentsEnabled(agentConfig)
      ? await subagentRosters.resolverFor(agentId)
      : createStaticResolver([]);

    // Tool accessors are evaluated at invocation time, after construction.
    // The annotation breaks the circular inference through these closures.
    const backend: PiAgentBackend = createBackend({
      config: {
        model: agentConfig.model,
        systemPrompt: agentConfig.systemPrompt,
        fallbackModels: agentConfig.fallbackModels,
        tools: agentConfig.tools,
        allowedProviders: agentConfig.providers,
        skills: {
          ...agentConfig.skills,
          paths: [...(agentConfig.skills?.paths ?? []), ...skillDirs],
        },
        memory: agentConfig.memoryRuntime,
      },
      providerApiKeysSource: credentialProvider,
      sessionDir,
      managedSkillsDir: resolve(dataDir, 'skills', agentConfig.name),
      mcpManager,
      mcpConfigStore,
      mcpAgentContext,
      extraTools: [
        ...createProjectsTools({
          db: projectsDb,
          getSessionId: () => backend.getCurrentSessionId(),
          // Projects' persisted agent identity is the name, unlike swarm's id.
          getAgentId: () => agentConfig.name,
        }),
        ...(createSubagentExtraTools({
          coordinator: swarmCoordinator,
          agentId,
          agentConfig,
          resolver,
          conversationId: () => backend.getCurrentSessionId() ?? '',
          parentTools: () => registry.get(agentId)?.config.tools,
          parentMcpTools: () =>
            orchestratorMcpToolNames(registry.get(agentId)?.config, listMcpToolNames),
          parentModel: () => registry.get(agentId)?.config.model ?? agentConfig.model,
          parentModelAliases: () =>
            registry.get(agentId)?.config.subagents?.modelAliases ??
            agentConfig.subagents?.modelAliases ??
            {},
          listSkills: () => backend.listSkills(),
        }) as unknown as ExtraTool[]),
        ...(agentConfig.location?.enabled === false
          ? []
          : [createGetLocationTool(() => backend.getCurrentLocation() ?? undefined)]),
      ],
      extraSkillFiles: commandFiles,
      hookRunner: wiring.hookEngine,
      pluginModelCatalog: wiring.pluginModelCatalog,
    });
    return backend;
  };
}
