import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TSchema } from '@sinclair/typebox';
import { interpolateConfigEnvVars } from './env.js';
import { wrapMcpTool } from './tools.js';
import { DEFAULT_TOOL_TIMEOUT } from './types.js';
import type { McpLogger, McpServerConfig, McpServerStatus } from './types.js';

export class McpClient {
  private config: McpServerConfig;
  private logger: McpLogger;
  private client: Client | null = null;
  private transport:
    | StdioClientTransport
    | SSEClientTransport
    | StreamableHTTPClientTransport
    | null = null;
  private tools: AgentTool<TSchema>[] = [];
  private _status: McpServerStatus = 'disconnected';

  constructor(config: McpServerConfig, logger?: McpLogger) {
    this.logger = logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.config = interpolateConfigEnvVars(config, this.logger);
  }

  get name(): string {
    return this.config.name;
  }

  get status(): McpServerStatus {
    return this._status;
  }

  async start(): Promise<void> {
    const { transport: transportConfig } = this.config;
    const toolTimeout = this.config.toolTimeout ?? DEFAULT_TOOL_TIMEOUT;

    this.client = new Client({ name: 'dash-mcp-client', version: '1.0.0' });

    if (transportConfig.type === 'stdio') {
      this.transport = new StdioClientTransport({
        command: transportConfig.command,
        args: transportConfig.args,
        env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
      });
    } else if (transportConfig.type === 'sse') {
      const url = new URL(transportConfig.url);
      const headers = transportConfig.headers;
      this.transport = new SSEClientTransport(url, headers ? { requestInit: { headers } } : {});
    } else if (transportConfig.type === 'streamable-http') {
      const url = new URL(transportConfig.url);
      const headers = transportConfig.headers;
      this.transport = new StreamableHTTPClientTransport(
        url,
        headers ? { requestInit: { headers } } : {},
      );
    } else {
      throw new Error(`Unsupported transport type: ${(transportConfig as { type: string }).type}`);
    }

    this.logger.info(`[mcp:${this.config.name}] connecting...`);
    await this.client.connect(this.transport);

    const result = await this.client.listTools();

    const callTool = async (name: string, params: Record<string, unknown>) => {
      if (!this.client) {
        throw new Error('MCP client is not connected');
      }
      const res = await this.client.callTool({ name, arguments: params });
      return res as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    };

    this.tools = result.tools.map((def) =>
      wrapMcpTool(
        this.config.name,
        { name: def.name, description: def.description, inputSchema: def.inputSchema },
        callTool,
        toolTimeout,
      ),
    );

    this._status = 'connected';
    this.logger.info(
      `[mcp:${this.config.name}] connected, ${this.tools.length} tool(s) discovered`,
    );
  }

  async stop(): Promise<void> {
    this.logger.info(`[mcp:${this.config.name}] disconnecting...`);
    try {
      if (this.transport) {
        await this.transport.close();
      }
    } catch (err) {
      this.logger.warn(
        `[mcp:${this.config.name}] error during disconnect: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.transport = null;
      this.client = null;
      this.tools = [];
      this._status = 'disconnected';
    }
  }

  getTools(): AgentTool<TSchema>[] {
    return this.tools;
  }
}
