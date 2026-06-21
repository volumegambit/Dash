/**
 * @dash/plugin-sdk — author/host-shared types for Claude Code-compatible
 * Dash plugins. Types-heavy, near-zero runtime. No dependency on any other
 * @dash package. Grows per plan (hook payloads in Plan 3, ProviderCatalog in
 * Plan 5); Plan 1 defines only the manifest.
 *
 * The manifest is Claude Code's `.claude-plugin/plugin.json`. It is OPTIONAL
 * (name falls back to the plugin directory basename); when present, only
 * `name` is required, and unrecognized top-level fields are IGNORED so one
 * manifest can double as a Claude/Codex/Cursor manifest.
 */

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  /** kebab-case; namespaces the plugin's components. Required when a manifest exists. */
  name: string;
  /** Human-readable name for pickers; falls back to `name`. */
  displayName?: string;
  /** Semver. If omitted, the host falls back to a git SHA / 'unknown'. */
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /**
   * Extra skill directories (each containing `<name>/SKILL.md`). Relative,
   * starting with './'. ADDS to the default `skills/` scan (never replaces it).
   */
  skills?: string[];
  /**
   * Command directories/files (`*.md`). Relative, starting with './'.
   * REPLACES the default `commands/` scan. Parsed in Plan 2.
   */
  commands?: string[];
}

/**
 * Claude Code hook lifecycle events. A plugin's `hooks/hooks.json` maps a
 * subset of these to shell commands the host runs. Unknown keys in a real
 * file are tolerated by the parser (the engine simply never fires them).
 */
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop';

/** A single shell command a hook runs. `timeout` is in seconds (Claude Code semantics). */
export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

/**
 * A group of commands for an event, optionally gated by a `matcher` (e.g. a
 * tool name for PreToolUse/PostToolUse). Absent matcher → always applies.
 */
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** Parsed `hooks.json`: event → matcher groups. */
export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>;

/** Marker so the host can assert it links a compatible SDK build. */
export const PLUGIN_TYPES_VERSION = 1 as const;
