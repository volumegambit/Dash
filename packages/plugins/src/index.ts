export type {
  HookConfigEntry,
  LoadedPlugins,
  McpConfigEntry,
  PluginEntryConfig,
  PluginFailure,
  PluginFailurePhase,
  PluginRecord,
  PluginStatus,
} from './types.js';
export {
  containedPath,
  MANIFEST_DIR,
  MANIFEST_FILENAME,
  readManifest,
  resolveAgentFiles,
  resolveBinDir,
  resolveCommandFiles,
  resolveSkillDirs,
  validateManifest,
} from './manifest.js';
export { HOOKS_FILE, readHooksJson, validateHooksJson } from './hooks-manifest.js';
export { PluginConfigStore } from './config-store.js';
export { loadPlugins } from './loader.js';
export type { LoadPluginsOptions } from './loader.js';
export { translateMcpJson } from './mcp-translate.js';
export { hookEnv, substituteVars } from './substitute.js';
export { createHookEngine } from './hook-engine.js';
export type {
  HookEngine,
  HookEngineOptions,
  LifecycleInput,
  LifecycleResult,
  PromptDecision,
  PromptInput,
  ToolPostDecision,
  ToolPostInput,
  ToolPreDecision,
  ToolPreInput,
} from './hook-engine.js';
