import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import type { McpManager } from './manager.js';
import type { McpProposalStore } from './proposals.js';
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

const confirmAddSchema = Type.Object({
  name: Type.String({ description: 'Name of the server to confirm' }),
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

// --- Tool factories ---

export interface McpAddServerDeps {
  proposalStore: McpProposalStore;
  configStore: McpConfigStoreInterface;
  logger?: McpLogger;
}

export function createMcpAddServerTool(
  deps: McpAddServerDeps,
): AgentTool<typeof addServerSchema, McpToolDetails> {
  return {
    name: 'mcp_add_server',
    label: 'MCP: Add Server',
    description:
      'Propose connecting to an MCP server. Creates a pending proposal that needs user confirmation via mcp_confirm_add.',
    parameters: addServerSchema,
    execute: async (
      _toolCallId: string,
      params: Static<typeof addServerSchema>,
    ): Promise<AgentToolResult<McpToolDetails>> => {
      const config = buildConfig(params);

      // Allowlist check for URL-based transports
      const url =
        config.transport.type === 'sse' || config.transport.type === 'streamable-http'
          ? config.transport.url
          : undefined;

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

      deps.proposalStore.add(params.name, config);
      deps.logger?.info(`[mcp:audit] mcp:proposal:created source=agent server=${params.name}`);

      const transportDesc =
        config.transport.type === 'stdio'
          ? `command: ${(config.transport as { command: string }).command}`
          : `URL: ${url}`;

      return ok(
        `Pending approval to connect MCP server "${params.name}" (${config.transport.type}, ${transportDesc}).\n\n` +
          `Please confirm by asking the user if they approve, then call mcp_confirm_add with name "${params.name}".`,
      );
    },
  };
}

export interface McpConfirmAddDeps {
  proposalStore: McpProposalStore;
  manager: McpManager;
  configStore: McpConfigStoreInterface;
  logger?: McpLogger;
}

export function createMcpConfirmAddTool(
  deps: McpConfirmAddDeps,
): AgentTool<typeof confirmAddSchema, McpToolDetails> {
  return {
    name: 'mcp_confirm_add',
    label: 'MCP: Confirm Add Server',
    description:
      'Confirm a pending MCP server proposal. Call this after the user approves the connection proposed by mcp_add_server.',
    parameters: confirmAddSchema,
    execute: async (
      _toolCallId: string,
      params: Static<typeof confirmAddSchema>,
    ): Promise<AgentToolResult<McpToolDetails>> => {
      const proposal = deps.proposalStore.get(params.name);
      if (!proposal) {
        return err(
          `No pending proposal found for "${params.name}". It may have expired (proposals last 5 minutes). Use mcp_add_server to create a new proposal.`,
        );
      }

      try {
        await deps.manager.addServer(proposal.config);
        await deps.configStore.addConfig(proposal.config);
        deps.proposalStore.remove(params.name);

        deps.logger?.info(`[mcp:audit] mcp:proposal:confirmed source=agent server=${params.name}`);

        const tools = deps.manager
          .getTools()
          .filter((t) => t.name.startsWith(`${params.name}__`))
          .map((t) => t.name);

        return ok(
          `MCP server "${params.name}" connected successfully.\nDiscovered ${tools.length} tool(s): ${tools.join(', ') || '(none)'}.\nThese tools will be available on the next message.`,
        );
      } catch (error) {
        deps.proposalStore.remove(params.name);
        const message = error instanceof Error ? error.message : String(error);
        return err(`Failed to connect MCP server "${params.name}": ${message}`);
      }
    },
  };
}

export interface McpListServersDeps {
  manager: McpManager;
  configStore: McpConfigStoreInterface;
}

export function createMcpListServersTool(
  deps: McpListServersDeps,
): AgentTool<typeof listServersSchema, McpToolDetails> {
  return {
    name: 'mcp_list_servers',
    label: 'MCP: List Servers',
    description: 'List all connected MCP servers and their available tools.',
    parameters: listServersSchema,
    execute: async (): Promise<AgentToolResult<McpToolDetails>> => {
      const configs = await deps.configStore.loadConfigs();

      if (configs.length === 0) {
        return ok('No MCP servers configured.');
      }

      const lines = configs.map((cfg) => {
        const status = deps.manager.getServerStatus(cfg.name);
        const tools = deps.manager
          .getTools()
          .filter((t) => t.name.startsWith(`${cfg.name}__`))
          .map((t) => t.name);

        const transportDesc =
          cfg.transport.type === 'stdio'
            ? cfg.transport.command
            : (cfg.transport as { url: string }).url;

        return (
          `• ${cfg.name} [${status}] (${cfg.transport.type}: ${transportDesc})\n` +
          `  Tools: ${tools.length > 0 ? tools.join(', ') : '(none)'}`
        );
      });

      return ok(lines.join('\n\n'));
    },
  };
}

export interface McpRemoveServerDeps {
  manager: McpManager;
  configStore: McpConfigStoreInterface;
  logger?: McpLogger;
}

export function createMcpRemoveServerTool(
  deps: McpRemoveServerDeps,
): AgentTool<typeof removeServerSchema, McpToolDetails> {
  return {
    name: 'mcp_remove_server',
    label: 'MCP: Remove Server',
    description: 'Disconnect and remove an MCP server.',
    parameters: removeServerSchema,
    execute: async (
      _toolCallId: string,
      params: Static<typeof removeServerSchema>,
    ): Promise<AgentToolResult<McpToolDetails>> => {
      try {
        await deps.manager.removeServer(params.name);
        await deps.configStore.removeConfig(params.name);
        deps.logger?.info(`[mcp:audit] mcp:server:removed source=agent server=${params.name}`);
        return ok(`MCP server "${params.name}" disconnected and removed.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(`Failed to remove MCP server "${params.name}": ${message}`);
      }
    },
  };
}
