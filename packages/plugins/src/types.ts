import type { McpServerConfig } from '@dash/mcp';

export type PluginStatus = 'loaded' | 'disabled' | 'error';

export type PluginFailurePhase = 'discovery' | 'manifest' | 'route';

export interface PluginFailure {
  phase: PluginFailurePhase;
  error: string;
  /** ISO timestamp. */
  failedAt: string;
}

/**
 * Per-plugin config + trust entry, persisted at <dataDir>/plugins/config.json.
 * `enabled` gates visibility; `trusted` additionally gates code-execution
 * components (hooks/MCP/providers/bin) introduced in Plan 2+. `path` points a
 * named entry at a local/linked dev plugin dir (auto-enabled — explicit intent).
 */
export interface PluginEntryConfig {
  enabled: boolean;
  trusted?: boolean;
  config?: Record<string, unknown>;
  path?: string;
}

export interface PluginRecord {
  name: string;
  version?: string;
  description?: string;
  status: PluginStatus;
  /** Absolute plugin root directory. */
  dir: string;
  /** Resolved skill directories this plugin contributes (each scanned for <name>/SKILL.md). */
  skillDirs: string[];
  /** Component kinds activated this plan, e.g. ['skills']. */
  activated: string[];
  /** Component kinds present on disk but not activated yet (deferred plans). */
  noop: string[];
  failure?: PluginFailure;
}

/** A translated MCP server config, tagged with the plugin that contributed it. */
export interface McpConfigEntry {
  pluginName: string;
  config: McpServerConfig;
}

export interface LoadedPlugins {
  records: PluginRecord[];
  /** Flattened skill dirs across all loaded plugins (for config.skills.paths). */
  skillDirs: string[];
  /**
   * Flat command .md files from enabled plugins (markdown — no trust needed),
   * each tagged with the plugin that contributed it so the host can namespace
   * the derived skill as `<plugin>:<command>`.
   */
  commandFiles: Array<{ pluginName: string; file: string }>;
  /** bin/ dirs from enabled+trusted plugins (code execution — requires trust). */
  binDirs: string[];
  /** Translated MCP servers from enabled+trusted plugins, tagged by plugin. */
  mcpConfigs: McpConfigEntry[];
}
