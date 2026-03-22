import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { TSchema } from '@sinclair/typebox';
import { McpClient } from './client.js';
import type { McpLogger, McpServerConfig, McpServerStatus } from './types.js';
import { NAMESPACE_SEPARATOR, SERVER_NAME_PATTERN } from './types.js';

interface FailedServer {
  name: string;
  error: string;
}

export interface McpManagerOptions {
  logger?: McpLogger;
  onToolsChanged?: (serverName: string, tools: AgentTool<TSchema>[]) => void;
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private failedServers: FailedServer[] = [];
  private logger?: McpLogger;
  private onToolsChanged?: (serverName: string, tools: AgentTool<TSchema>[]) => void;

  constructor(
    private servers: McpServerConfig[],
    options?: McpManagerOptions,
  ) {
    this.logger = options?.logger;
    this.onToolsChanged = options?.onToolsChanged;

    const seen = new Set<string>();
    for (const server of servers) {
      if (!SERVER_NAME_PATTERN.test(server.name)) {
        throw new Error(
          `Invalid MCP server name "${server.name}": must match ${SERVER_NAME_PATTERN}`,
        );
      }
      if (server.name.includes(NAMESPACE_SEPARATOR)) {
        throw new Error(
          `Invalid MCP server name "${server.name}": must not contain "${NAMESPACE_SEPARATOR}"`,
        );
      }
      if (seen.has(server.name)) {
        throw new Error(`Duplicate MCP server name "${server.name}"`);
      }
      seen.add(server.name);
    }
  }

  async start(): Promise<void> {
    this.failedServers = [];
    const results = await Promise.allSettled(
      this.servers.map(async (config) => {
        const client = new McpClient(config, {
          logger: this.logger,
          onToolsChanged: this.onToolsChanged,
        });
        await client.start();
        return client;
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const config = this.servers[i];
      if (result.status === 'fulfilled') {
        this.clients.set(config.name, result.value);
      } else {
        const errMsg =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.failedServers.push({ name: config.name, error: errMsg });
        this.logger?.warn(`[MCP] Server "${config.name}" failed to start: ${errMsg}`);
      }
    }
    this.logger?.info(`[MCP] ${this.clients.size}/${this.servers.length} server(s) connected`);
  }

  async stop(): Promise<void> {
    await Promise.allSettled(Array.from(this.clients.values()).map((c) => c.stop()));
    this.clients.clear();
    this.failedServers = [];
  }

  async addServer(config: McpServerConfig): Promise<void> {
    if (!SERVER_NAME_PATTERN.test(config.name)) {
      throw new Error(
        `Invalid MCP server name "${config.name}": must match ${SERVER_NAME_PATTERN}`,
      );
    }
    if (config.name.includes(NAMESPACE_SEPARATOR)) {
      throw new Error(
        `Invalid MCP server name "${config.name}": must not contain "${NAMESPACE_SEPARATOR}"`,
      );
    }
    if (this.clients.has(config.name)) {
      throw new Error(`MCP server "${config.name}" already exists`);
    }

    const client = new McpClient(config, {
      logger: this.logger,
      onToolsChanged: this.onToolsChanged,
    });
    await client.start();
    this.clients.set(config.name, client);
    this.logger?.info(`[MCP] Server "${config.name}" added at runtime`);
  }

  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`MCP server "${name}" not found`);
    }
    await client.stop();
    this.clients.delete(name);
    this.logger?.info(`[MCP] Server "${name}" removed`);
  }

  getTools(): AgentTool<TSchema, unknown>[] {
    const tools: AgentTool<TSchema, unknown>[] = [];
    for (const client of this.clients.values()) {
      tools.push(...client.getTools());
    }
    return tools;
  }

  getServerStatus(name: string): McpServerStatus {
    const client = this.clients.get(name);
    if (client) return client.status;
    if (this.failedServers.find((f) => f.name === name)) return 'error';
    return 'disconnected';
  }

  getFailedServers(): FailedServer[] {
    return [...this.failedServers];
  }
}
