import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { McpManager } from './manager.js';
import type { McpLogger, McpServerConfig } from './types.js';

/**
 * Minimal interface for config store — decouples agent tools from gateway.
 * The gateway's McpConfigStore implements this.
 */
export interface McpConfigStoreInterface {
  loadConfigs(): Promise<McpServerConfig[]>;
  addConfig(config: McpServerConfig): Promise<void>;
  removeConfig(name: string): Promise<void>;
  isAllowed(url: string): Promise<boolean>;
}

/**
 * Agent identity context — provides per-agent MCP server assignment operations.
 * Constructed by the gateway with closures that capture the agent name and registry.
 */
export interface McpAgentContext {
  /** Assign an MCP server to this agent */
  assignToAgent(serverName: string): Promise<void>;
  /** Unassign from this agent. Returns true if also removed from pool (no other refs). */
  unassignFromAgent(serverName: string): Promise<boolean>;
  /** Get this agent's assigned server names */
  getAssignedServers(): string[];
}

interface McpToolDetails {
  isError?: boolean;
}

// --- Schemas ---

const addServerSchema = Type.Object({
  name: Type.String({ description: 'Unique name for the MCP server' }),
  transportType: Type.Union(
    [Type.Literal('stdio'), Type.Literal('sse'), Type.Literal('streamable-http')],
    { description: 'Transport type' },
  ),
  url: Type.Optional(Type.String({ description: 'Server URL (required for sse/streamable-http)' })),
  command: Type.Optional(Type.String({ description: 'Command to run (required for stdio)' })),
  args: Type.Optional(Type.Array(Type.String(), { description: 'Command arguments (stdio)' })),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: 'HTTP headers' }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: 'Environment variables' }),
  ),
});

const removeServerSchema = Type.Object({
  name: Type.String({ description: 'Name of the MCP server to remove' }),
});

const listServersSchema = Type.Object({});

// --- Helpers ---

function ok(text: string): AgentToolResult<McpToolDetails> {
  return { content: [{ type: 'text', text }], details: {} };
}

function err(text: string): AgentToolResult<McpToolDetails> {
  return { content: [{ type: 'text', text }], details: { isError: true } };
}

function buildConfig(params: Static<typeof addServerSchema>): McpServerConfig {
  let transport: McpServerConfig['transport'];

  if (params.transportType === 'stdio') {
    transport = {
      type: 'stdio',
      command: params.command ?? '',
      args: params.args,
    };
  } else if (params.transportType === 'sse') {
    transport = {
      type: 'sse',
      url: params.url ?? '',
      headers: params.headers,
    };
  } else {
    transport = {
      type: 'streamable-http',
      url: params.url ?? '',
      headers: params.headers,
    };
  }

  return {
    name: params.name,
    transport,
    env: params.env,
  };
}

function getConfigUrl(config: McpServerConfig): string | undefined {
  const t = config.transport;
  if (t.type === 'sse' || t.type === 'streamable-http') return t.url;
  return undefined;
}

// --- Tool factories ---

export interface McpAddServerDeps {
  manager: McpManager;
  configStore: McpConfigStoreInterface;
  agentContext: McpAgentContext;
  logger?: McpLogger;
}

export function createMcpAddServerTool(
  deps: McpAddServerDeps,
): AgentTool<typeof addServerSchema, McpToolDetails> {
  return {
    name: 'mcp_add_server',
    label: 'MCP: Add Server',
    description:
      'Connect to an MCP server. If the server already exists in the pool, assigns it to this agent. Otherwise creates a new connection.',
    parameters: addServerSchema,
    execute: async (
      _toolCallId: string,
      params: Static<typeof addServerSchema>,
    ): Promise<AgentToolResult<McpToolDetails>> => {
      const config = buildConfig(params);
      const url = getConfigUrl(config);

      // Allowlist check for URL-based transports
      if (url) {
        const allowed = await deps.configStore.isAllowed(url);
        if (!allowed) {
          deps.logger?.info(
            `[mcp:audit] mcp:proposal:rejected source=agent server=${params.name} reason=allowlist`,
          );
          return err(
            `Server URL "${url}" is not in the allowlist. Contact your administrator to add it.`,
          );
        }
      }

      // Check if server already exists in pool
      const existingConfigs = await deps.configStore.loadConfigs();
      const existing = existingConfigs.find((c) => c.name === params.name);

      if (existing) {
        // Server exists — check if same URL
        const existingUrl = getConfigUrl(existing);
        if (url && existingUrl && url !== existingUrl) {
          return err(
            `MCP server "${params.name}" already exists with a different URL (${existingUrl}). Choose another name.`,
          );
        }

        // Same server — just assign to this agent
        await deps.agentContext.assignToAgent(params.name);
        deps.logger?.info(`[mcp:audit] mcp:server:assigned source=agent server=${params.name}`);

        const tools = deps.manager
          .getTools()
          .filter((t) => t.name.startsWith(`${params.name}__`))
          .map((t) => t.name);

        return ok(
          `MCP server "${params.name}" assigned to this agent.\n${tools.length} tool(s) available: ${tools.join(', ') || '(none)'}.\nThese tools will be available on the next message.`,
        );
      }

      // New server — create + assign
      try {
        await deps.manager.addServer(config);
        await deps.configStore.addConfig(config);
        await deps.agentContext.assignToAgent(params.name);

        deps.logger?.info(`[mcp:audit] mcp:server:added source=agent server=${params.name}`);

        const tools = deps.manager
          .getTools()
          .filter((t) => t.name.startsWith(`${params.name}__`))
          .map((t) => t.name);

        return ok(
          `MCP server "${params.name}" connected and assigned to this agent.\nDiscovered ${tools.length} tool(s): ${tools.join(', ') || '(none)'}.\nThese tools will be available on the next message.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(`Failed to connect MCP server "${params.name}": ${message}`);
      }
    },
  };
}

export interface McpListServersDeps {
  manager: McpManager;
  configStore: McpConfigStoreInterface;
  agentContext: McpAgentContext;
}

export function createMcpListServersTool(
  deps: McpListServersDeps,
): AgentTool<typeof listServersSchema, McpToolDetails> {
  return {
    name: 'mcp_list_servers',
    label: 'MCP: List Servers',
    description: 'List MCP servers assigned to this agent and other available servers in the pool.',
    parameters: listServersSchema,
    execute: async (): Promise<AgentToolResult<McpToolDetails>> => {
      const allConfigs = await deps.configStore.loadConfigs();
      const assigned = new Set(deps.agentContext.getAssignedServers());

      if (allConfigs.length === 0) {
        return ok('No MCP servers in the pool.');
      }

      const assignedLines: string[] = [];
      const availableLines: string[] = [];

      for (const cfg of allConfigs) {
        const status = deps.manager.getServerStatus(cfg.name);
        const tools = deps.manager
          .getTools()
          .filter((t) => t.name.startsWith(`${cfg.name}__`))
          .map((t) => t.name);

        const transportDesc =
          cfg.transport.type === 'stdio'
            ? cfg.transport.command
            : (cfg.transport as { url: string }).url;

        const line =
          `• ${cfg.name} [${status}] (${cfg.transport.type}: ${transportDesc})\n` +
          `  Tools: ${tools.length > 0 ? tools.join(', ') : '(none)'}`;

        if (assigned.has(cfg.name)) {
          assignedLines.push(line);
        } else {
          availableLines.push(line);
        }
      }

      const parts: string[] = [];
      if (assignedLines.length > 0) {
        parts.push(`**Assigned to this agent:**\n\n${assignedLines.join('\n\n')}`);
      } else {
        parts.push('**Assigned to this agent:** none');
      }
      if (availableLines.length > 0) {
        parts.push(`**Available in pool (not assigned):**\n\n${availableLines.join('\n\n')}`);
      }

      return ok(parts.join('\n\n'));
    },
  };
}

export interface McpRemoveServerDeps {
  manager: McpManager;
  configStore: McpConfigStoreInterface;
  agentContext: McpAgentContext;
  logger?: McpLogger;
}

export function createMcpRemoveServerTool(
  deps: McpRemoveServerDeps,
): AgentTool<typeof removeServerSchema, McpToolDetails> {
  return {
    name: 'mcp_remove_server',
    label: 'MCP: Remove Server',
    description:
      'Unassign an MCP server from this agent. If no other agents use it, removes it from the pool entirely.',
    parameters: removeServerSchema,
    execute: async (
      _toolCallId: string,
      params: Static<typeof removeServerSchema>,
    ): Promise<AgentToolResult<McpToolDetails>> => {
      const assigned = deps.agentContext.getAssignedServers();
      if (!assigned.includes(params.name)) {
        return err(`MCP server "${params.name}" is not assigned to this agent.`);
      }

      try {
        const removedFromPool = await deps.agentContext.unassignFromAgent(params.name);
        deps.logger?.info(
          `[mcp:audit] mcp:server:removed source=agent server=${params.name} poolRemoved=${removedFromPool}`,
        );

        if (removedFromPool) {
          return ok(
            `MCP server "${params.name}" unassigned and removed from the pool (no other agents were using it).`,
          );
        }
        return ok(
          `MCP server "${params.name}" unassigned from this agent. Other agents still use it, so it remains in the pool.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(`Failed to remove MCP server "${params.name}": ${message}`);
      }
    },
  };
}
