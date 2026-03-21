export type {
  AgentBackend,
  AgentState,
  AgentEvent,
  ImageBlock,
  RunOptions,
  DashAgentConfig,
} from './types.js';
export { DashAgent } from './agent.js';
export { PiAgentBackend } from './backends/piagent.js';
export type { AgentClient, BackendFactory } from './client.js';
export { LocalAgentClient, PooledAgentClient } from './client.js';
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
] as const;
