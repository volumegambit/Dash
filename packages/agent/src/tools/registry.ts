/**
 * Tool registry — open extension point for the tools exposed to a PiAgent
 * session. Replaces the previous hardcoded if/else branches in
 * `PiAgentBackend.buildBuiltinTools` and `PiAgentBackend.buildCustomTools`.
 *
 * Two flavors of factory share this registry because PiAgent splits tools
 * into two distinct lists at construction time:
 *
 *   - "builtin" tools go into `createAgentSession({ tools })` and must be
 *     pi-coding-agent's native tool shape (recognized by name).
 *   - "custom" tools go into `createAgentSession({ customTools })` and use
 *     pi-coding-agent's `ToolDefinition` shape (with the legacy `ctx` param).
 *
 * Factories return tools in whichever shape matches their `kind`. Custom
 * factories that wrap an `AgentTool` should use `wrapAgentTool()` to add the
 * `ctx` shim once.
 */

import type { McpAgentContext, McpConfigStoreInterface, McpManager } from '@dash/mcp';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { Logger } from '../logger.js';
import type { SkillDiscoveryResult } from '../skills/types.js';
import type { DashAgentConfig } from '../types.js';

/**
 * Context passed to every tool factory's `create()` call. Carries everything
 * a factory might need to decide whether and how to instantiate its tool.
 *
 * A factory can return `null` to opt out (e.g. dependency missing) and the
 * registry will silently skip it.
 */
export interface ToolFactoryContext {
  /** Agent workspace directory (filesystem root for read/write/bash tools) */
  workspace: string;

  /** The full agent config — factories can read arbitrary fields if needed */
  config: DashAgentConfig;

  /** Resolved provider API keys (e.g. `provider:value` map) */
  providerApiKeys: Record<string, string>;

  /** Directory where skills authored at runtime are stored, if any */
  managedSkillsDir?: string;

  /** Active MCP manager, if MCP is wired up for this backend instance */
  mcpManager?: McpManager;

  /** MCP config persistence, if MCP management tools should be available */
  mcpConfigStore?: McpConfigStoreInterface;

  /** Context object MCP management tools mutate (selected servers, etc.) */
  mcpAgentContext?: McpAgentContext;

  /** Backend logger — factories should log through this, not console */
  logger?: Logger;

  /** Discover skills (paths + URLs + managed dir) — wired to backend.listSkills() */
  listSkills(): Promise<SkillDiscoveryResult[]>;

  /**
   * Notify the backend that the MCP server set has changed. The backend
   * uses this to rebuild custom tools and inject them into the live pi
   * session (since pi freezes customTools at session construction time).
   */
  onMcpToolsChanged(): void;

  /**
   * Tool names the operator has enabled (the `config.tools` array). When
   * `config.tools` is omitted, callers should pass the default set.
   * Factories whose `optional` flag is true are skipped unless their `id`
   * is in this set.
   */
  allowedToolNames: ReadonlySet<string>;
}

/**
 * Shape of a built-in tool. We can't import pi-coding-agent's `Tool` type
 * because it isn't exported from the package's top-level, so this is `unknown`
 * — factories are responsible for returning the right shape.
 */
export type BuiltinTool = unknown;

/**
 * Shape of a custom tool (pi-coding-agent `ToolDefinition`-like). Not
 * exported from the SDK either, so we use a structural minimum.
 */
export interface CustomTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (...args: unknown[]) => unknown;
}

interface BaseFactory {
  /** Stable id — must be unique across the registry */
  readonly id: string;
  /** Human-readable label for UIs / docs */
  readonly label?: string;
  /**
   * If true (default), the factory is only invoked when its `id` is in the
   * context's `allowedToolNames` set. Set to false for tools that are
   * always-on regardless of operator selection (e.g. `task`, `load_skill`).
   */
  readonly optional?: boolean;
}

export interface BuiltinToolFactory extends BaseFactory {
  readonly kind: 'builtin';
  create(context: ToolFactoryContext): BuiltinTool | null;
}

export interface CustomToolFactory extends BaseFactory {
  readonly kind: 'custom';
  /**
   * Custom factories may return a single tool, an array of tools, or `null`
   * to opt out. The array form supports dynamic groups (e.g. all MCP server
   * tools), where one factory expands into N tools at build time.
   */
  create(context: ToolFactoryContext): CustomTool | CustomTool[] | null;
}

export type ToolFactory = BuiltinToolFactory | CustomToolFactory;

/**
 * Wrap an `AgentTool` (the @mariozechner/pi-agent-core shape) as a
 * `CustomTool` (the pi-coding-agent customTools shape). The wrapper adds
 * the unused `ctx` parameter pi's customTools API expects.
 */
// biome-ignore lint/suspicious/noExplicitAny: pi-agent-core's AgentTool generic
export function wrapAgentTool(tool: AgentTool<any>): CustomTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: (
      toolCallId: unknown,
      // biome-ignore lint/suspicious/noExplicitAny: param types from SDK are not exported
      params: any,
      signal?: unknown,
      // biome-ignore lint/suspicious/noExplicitAny: onUpdate callback from SDK is not exported
      onUpdate?: any,
      _ctx?: unknown,
    ) => tool.execute(toolCallId as string, params, signal as AbortSignal | undefined, onUpdate),
  };
}

/**
 * In-memory registry of tool factories. Insertion order is preserved —
 * `buildBuiltin()` and `buildCustom()` emit tools in registration order.
 */
export class ToolRegistry {
  private readonly factories = new Map<string, ToolFactory>();

  /**
   * Register a factory. Throws if `factory.id` is already taken — the
   * registry will not silently overwrite (this is what makes
   * `createDefaultToolRegistry()` safe to compose with extension points).
   */
  register(factory: ToolFactory): this {
    if (this.factories.has(factory.id)) {
      throw new Error(`Tool factory '${factory.id}' is already registered`);
    }
    this.factories.set(factory.id, factory);
    return this;
  }

  get(id: string): ToolFactory | undefined {
    return this.factories.get(id);
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  /** Snapshot of all registered factories, in insertion order. */
  list(): ToolFactory[] {
    return [...this.factories.values()];
  }

  /**
   * Instantiate every registered built-in tool that:
   *   1. Is a builtin-kind factory, and
   *   2. Either has `optional: false`, or its id is in `allowedToolNames`, and
   *   3. Whose `create()` does not return `null`.
   */
  buildBuiltin(context: ToolFactoryContext): BuiltinTool[] {
    const out: BuiltinTool[] = [];
    for (const factory of this.factories.values()) {
      if (factory.kind !== 'builtin') continue;
      if (factory.optional !== false && !context.allowedToolNames.has(factory.id)) continue;
      const tool = factory.create(context);
      if (tool !== null && tool !== undefined) out.push(tool);
    }
    return out;
  }

  /**
   * Instantiate every registered custom tool, flattening factories that
   * return arrays. Same gating rules as `buildBuiltin`.
   */
  buildCustom(context: ToolFactoryContext): CustomTool[] {
    const out: CustomTool[] = [];
    for (const factory of this.factories.values()) {
      if (factory.kind !== 'custom') continue;
      if (factory.optional !== false && !context.allowedToolNames.has(factory.id)) continue;
      const result = factory.create(context);
      if (result === null || result === undefined) continue;
      if (Array.isArray(result)) {
        out.push(...result);
      } else {
        out.push(result);
      }
    }
    return out;
  }
}
