export type {
  AgentBackend,
  AgentState,
  AgentEvent,
  RunOptions,
  DashAgentConfig,
} from './types.js';
export { DashAgent } from './agent.js';
export { OpenCodeBackend } from './backends/opencode.js';
export type { AgentClient } from './client.js';
export { LocalAgentClient } from './client.js';
export { FileLogger } from './logger.js';
export type { LogLevel } from './logger.js';
export { buildMemoryPreamble } from './memory.js';
export { estimateTokens, shouldCompact, compactSession } from './compaction.js';
export type { Session, SessionEntry, SessionStore } from './types.js';
export { JsonlSessionStore } from './session.js';
