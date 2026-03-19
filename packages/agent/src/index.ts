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
export type { AgentClient } from './client.js';
export { LocalAgentClient, PooledAgentClient } from './client.js';
export { FileLogger } from './logger.js';
export type { LogLevel, Logger } from './logger.js';
export { buildMemoryPreamble } from './memory.js';
export type { SkillDiscoveryResult, SkillFrontmatter } from './skills/index.js';
export { parseFrontmatter, generateFrontmatter, scanSkillsDirectory } from './skills/index.js';
export type { ParsedSkill } from './skills/index.js';

/**
 * Canonical list of all tool names supported by PiAgentBackend.
 * This is the single source of truth — import this in MC and model-cache
 * instead of maintaining separate lists.
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
  // Task tracking
  'task',
  // Skill tools
  'load_skill',
  'create_skill',
] as const;
