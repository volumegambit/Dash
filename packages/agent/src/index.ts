export type {
  AgentBackend,
  AgentState,
  AgentEvent,
  ImageBlock,
  RunOptions,
  DashAgentConfig,
} from './types.js';
export { DashAgent } from './agent.js';
export type { DashAgentConfigResolver } from './agent.js';
export { PiAgentBackend } from './backends/piagent.js';
export type { AgentClient } from './client.js';
export { FileLogger } from './logger.js';
export type { LogLevel, Logger } from './logger.js';
export { buildMemoryPreamble } from './memory.js';
export { ConversationPool } from './conversation-pool.js';
export type {
  ConversationPoolOptions,
  PoolEntry,
  PoolBackendFactory,
} from './conversation-pool.js';
export type { SkillDiscoveryResult, SkillFrontmatter } from './skills/index.js';
export { parseFrontmatter, generateFrontmatter, scanSkillsDirectory } from './skills/index.js';
export type { ParsedSkill } from './skills/index.js';

// Tool registry — open extension point for the tools handed to PiAgent sessions.
export { ToolRegistry, wrapAgentTool } from './tools/registry.js';
export type {
  BuiltinTool,
  BuiltinToolFactory,
  CustomTool,
  CustomToolFactory,
  ToolFactory,
  ToolFactoryContext,
} from './tools/registry.js';
export {
  BUILTIN_TOOL_NAMES,
  DEFAULT_ALLOWED_TOOL_NAMES,
  createDefaultToolRegistry,
  resolveAllowedToolNames,
  // Individual factories — exposed so callers can compose their own registry
  // (e.g. start from defaults but drop or override specific tools).
  bashToolFactory,
  createSkillToolFactory,
  editToolFactory,
  findToolFactory,
  grepToolFactory,
  loadSkillToolFactory,
  lsToolFactory,
  mcpAddServerToolFactory,
  mcpListServersToolFactory,
  mcpRemoveServerToolFactory,
  mcpToolsFactory,
  readToolFactory,
  taskToolFactory,
  webFetchToolFactory,
  webSearchToolFactory,
  writeToolFactory,
} from './tools/default-registry.js';

/**
 * Canonical list of user-configurable tool names supported by PiAgentBackend.
 * This is the single source of truth — import this in MC and model-cache
 * instead of maintaining separate lists.
 *
 * Note: `task` and `load_skill` are auto-registered by the backend and not
 * included here (they are not user-toggleable).
 */
export const AGENT_TOOL_NAMES = [
  // Built-in PiAgent tools
  'bash',
  'read',
  'write',
  'edit',
  'find',
  'ls',
  'grep',
  // Web tools
  'web_search',
  'web_fetch',
  // Skill tools
  'create_skill',
  // MCP
  'mcp',
  'mcp_add_server',
  'mcp_list_servers',
  'mcp_remove_server',
] as const;
