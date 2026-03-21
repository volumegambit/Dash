import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { TSchema } from '@sinclair/typebox';
import { McpClient } from './client.js';
import type { McpLogger, McpServerConfig, McpServerStatus } from './types.js';
import { NAMESPACE_SEPARATOR, SERVER_NAME_PATTERN } from './types.js';

interface FailedServer {
  name: string;
  error: string;
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private failedServers: FailedServer[] = [];

  constructor(
    private servers: McpServerConfig[],
    private logger?: McpLogger,
  ) {
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
    }
  }

  async start(): Promise<void> {
    this.failedServers = [];
    const results = await Promise.allSettled(
      this.servers.map(async (config) => {
        const client = new McpClient(config, this.logger);
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
