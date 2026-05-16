/**
 * Default tool registry — the in-tree, first-party set of tools the
 * gateway hands to every PiAgent session. Constructed lazily by callers
 * so the registry can be extended (or swapped wholesale) before being
 * passed to `PiAgentBackend`.
 *
 * Each factory below mirrors a branch from the previous hardcoded
 * `buildBuiltinTools` / `buildCustomTools` methods. Behavior is preserved
 * byte-for-byte — there is no new gating, no new tools, no new ordering.
 */

import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';

import {
  createMcpAddServerTool,
  createMcpListServersTool,
  createMcpRemoveServerTool,
} from '@dash/mcp';

import { createCreateSkillTool, createLoadSkillTool } from '../skills/index.js';
import { ToolRegistry, wrapAgentTool } from './registry.js';
import type { BuiltinToolFactory, CustomTool, CustomToolFactory } from './registry.js';
import { BraveSearchProvider } from './search-providers/brave.js';
import { createTodoWriteTool } from './todowrite.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';

// ───────── built-in (pi-coding-agent) tool factories ─────────

export const readToolFactory: BuiltinToolFactory = {
  kind: 'builtin',
  id: 'read',
  label: 'Read',
  create: (ctx) => createReadTool(ctx.workspace),
};

export const bashToolFactory: BuiltinToolFactory = {
  kind: 'builtin',
  id: 'bash',
  label: 'Bash',
  create: (ctx) => createBashTool(ctx.workspace),
};

export const editToolFactory: BuiltinToolFactory = {
  kind: 'builtin',
  id: 'edit',
  label: 'Edit',
  create: (ctx) => createEditTool(ctx.workspace),
};

export const writeToolFactory: BuiltinToolFactory = {
  kind: 'builtin',
  id: 'write',
  label: 'Write',
  create: (ctx) => createWriteTool(ctx.workspace),
};

export const grepToolFactory: BuiltinToolFactory = {
  kind: 'builtin',
  id: 'grep',
  label: 'Grep',
  create: (ctx) => createGrepTool(ctx.workspace),
};

export const findToolFactory: BuiltinToolFactory = {
  kind: 'builtin',
  id: 'find',
  label: 'Find',
  create: (ctx) => createFindTool(ctx.workspace),
};

export const lsToolFactory: BuiltinToolFactory = {
  kind: 'builtin',
  id: 'ls',
  label: 'List',
  create: (ctx) => createLsTool(ctx.workspace),
};

// ───────── custom (dash + MCP) tool factories ─────────

/**
 * `task` (todo_write) — always registered, not user-configurable. This is
 * core task-tracking infrastructure used by the system prompt.
 */
export const taskToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'task',
  label: 'Task',
  optional: false,
  create: () => wrapAgentTool(createTodoWriteTool()),
};

/**
 * `load_skill` — registered whenever the agent has any skill source wired
 * up (configured skill paths OR a managed skills directory). Not directly
 * user-configurable; gating mirrors the previous `hasSkillPaths || managedSkillsDir`
 * check.
 */
export const loadSkillToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'load_skill',
  label: 'Load Skill',
  optional: false,
  create: (ctx) => {
    const hasSkillPaths = !!(ctx.config.skills?.paths && ctx.config.skills.paths.length > 0);
    if (!hasSkillPaths && !ctx.managedSkillsDir) return null;
    return wrapAgentTool(createLoadSkillTool(() => ctx.listSkills()));
  },
};

export const webFetchToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'web_fetch',
  label: 'Web Fetch',
  create: () => wrapAgentTool(createWebFetchTool()),
};

export const webSearchToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'web_search',
  label: 'Web Search',
  create: (ctx) => {
    const braveKey = ctx.providerApiKeys.brave ?? ctx.providerApiKeys['brave-api-key'];
    const provider = braveKey ? new BraveSearchProvider(braveKey) : null;
    return wrapAgentTool(createWebSearchTool(provider));
  },
};

export const createSkillToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'create_skill',
  label: 'Create Skill',
  create: (ctx) => {
    if (!ctx.managedSkillsDir) return null;
    return wrapAgentTool(createCreateSkillTool(ctx.managedSkillsDir));
  },
};

/**
 * `mcp` — group factory that expands into all MCP server tools the agent
 * is allowed to see. Filtering mirrors the previous logic:
 *   - `assignedMcpServers === undefined` (legacy / standalone): show all
 *   - `assignedMcpServers` is `[]`: show none
 *   - non-empty array: show only tools from those servers
 */
export const mcpToolsFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'mcp',
  label: 'MCP Tools',
  create: (ctx) => {
    if (!ctx.mcpManager) return null;
    const assigned = ctx.config.assignedMcpServers;
    const all = ctx.mcpManager.getTools();
    // MCP tools come from `@mariozechner/pi-agent-core` as `AgentTool<TSchema, unknown>[]`
    // which is structurally a `CustomTool` (name/execute/etc.) — cast through unknown
    // because the SDK's TSchema generic doesn't line up with our minimal interface.
    if (assigned && assigned.length > 0) {
      const assignedSet = new Set(assigned);
      return all
        .filter((t) => {
          const serverName = t.name.split('__')[0];
          return assignedSet.has(serverName);
        })
        .map((t) => t as unknown as CustomTool);
    }
    if (!assigned) return all.map((t) => t as unknown as CustomTool);
    return null;
  },
};

export const mcpAddServerToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'mcp_add_server',
  label: 'MCP: Add Server',
  create: (ctx) => {
    if (!ctx.mcpManager || !ctx.mcpConfigStore || !ctx.mcpAgentContext) return null;
    return wrapAgentTool(
      createMcpAddServerTool({
        manager: ctx.mcpManager,
        configStore: ctx.mcpConfigStore,
        agentContext: ctx.mcpAgentContext,
        logger: ctx.logger,
        onToolsChanged: ctx.onMcpToolsChanged,
      }),
    );
  },
};

export const mcpListServersToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'mcp_list_servers',
  label: 'MCP: List Servers',
  create: (ctx) => {
    if (!ctx.mcpManager || !ctx.mcpConfigStore || !ctx.mcpAgentContext) return null;
    return wrapAgentTool(
      createMcpListServersTool({
        manager: ctx.mcpManager,
        configStore: ctx.mcpConfigStore,
        agentContext: ctx.mcpAgentContext,
      }),
    );
  },
};

export const mcpRemoveServerToolFactory: CustomToolFactory = {
  kind: 'custom',
  id: 'mcp_remove_server',
  label: 'MCP: Remove Server',
  create: (ctx) => {
    if (!ctx.mcpManager || !ctx.mcpConfigStore || !ctx.mcpAgentContext) return null;
    return wrapAgentTool(
      createMcpRemoveServerTool({
        manager: ctx.mcpManager,
        configStore: ctx.mcpConfigStore,
        agentContext: ctx.mcpAgentContext,
        logger: ctx.logger,
        onToolsChanged: ctx.onMcpToolsChanged,
      }),
    );
  },
};

/**
 * Construct a fresh registry populated with Dash's default tool set.
 *
 * Order matches the previous hardcoded build methods exactly:
 *   - builtin: read, bash, edit, write, grep, find, ls
 *   - custom:  task, load_skill, web_fetch, web_search, create_skill,
 *              mcp (server tools), mcp_add_server, mcp_list_servers,
 *              mcp_remove_server
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // built-in (pi-coding-agent) — order matches DEFAULT_TOOL_NAMES iteration
  registry.register(readToolFactory);
  registry.register(bashToolFactory);
  registry.register(editToolFactory);
  registry.register(writeToolFactory);
  registry.register(grepToolFactory);
  registry.register(findToolFactory);
  registry.register(lsToolFactory);
  // always-on customs (not user-toggleable)
  registry.register(taskToolFactory);
  registry.register(loadSkillToolFactory);
  // user-toggleable customs
  registry.register(webFetchToolFactory);
  registry.register(webSearchToolFactory);
  registry.register(createSkillToolFactory);
  registry.register(mcpToolsFactory);
  registry.register(mcpAddServerToolFactory);
  registry.register(mcpListServersToolFactory);
  registry.register(mcpRemoveServerToolFactory);
  return registry;
}

/**
 * The canonical default-list of operator-togglable tool names. Mirrors the
 * previous `DEFAULT_TOOL_NAMES` constant in piagent.ts but is now derived
 * from the seven built-in factories — keep both in sync if the order
 * ever changes.
 */
export const BUILTIN_TOOL_NAMES = [
  readToolFactory.id,
  bashToolFactory.id,
  editToolFactory.id,
  writeToolFactory.id,
  grepToolFactory.id,
  findToolFactory.id,
  lsToolFactory.id,
] as const;

/**
 * The default set of tool names enabled when `config.tools` is omitted.
 * Matches the previous behavior in `PiAgentBackend.buildBuiltinTools` /
 * `buildCustomTools`, which both defaulted to the built-in list.
 */
export const DEFAULT_ALLOWED_TOOL_NAMES: readonly string[] = BUILTIN_TOOL_NAMES;

/**
 * Helper: resolve `config.tools` into a `Set<string>` matching the
 * `ToolFactoryContext.allowedToolNames` shape. Falls back to the default
 * set when `config.tools` is undefined.
 */
export function resolveAllowedToolNames(configTools: string[] | undefined): Set<string> {
  return new Set(configTools ?? DEFAULT_ALLOWED_TOOL_NAMES);
}
