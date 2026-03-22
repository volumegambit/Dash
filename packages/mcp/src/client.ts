import type { AgentTool } from '@mariozechner/pi-agent-core';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { TSchema } from '@sinclair/typebox';
import { DashOAuthClientProvider } from './auth.js';
import { interpolateConfigEnvVars } from './env.js';
import { wrapMcpTool } from './tools.js';
import { DEFAULT_TOOL_TIMEOUT } from './types.js';
import type { McpLogger, McpServerConfig, McpServerStatus, TokenStore } from './types.js';

export interface McpClientOptions {
  logger?: McpLogger;
  onToolsChanged?: (serverName: string, tools: AgentTool<TSchema>[]) => void;
  tokenStore?: TokenStore;
  onAuthUrl?: (url: URL) => void;
}

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
  private toolTimeout = DEFAULT_TOOL_TIMEOUT;
  private options?: McpClientOptions;
  private onToolsChanged?: (serverName: string, tools: AgentTool<TSchema>[]) => void;
  private authProvider: DashOAuthClientProvider | null = null;

  /** Stored callTool closure, used by rebuildTools */
  private callToolFn:
    | ((
        name: string,
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>)
    | null = null;

  constructor(config: McpServerConfig, options?: McpClientOptions) {
    this.logger = options?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.config = interpolateConfigEnvVars(config, this.logger);
    this.options = options;
    this.onToolsChanged = options?.onToolsChanged;
  }

  get name(): string {
    return this.config.name;
  }

  get status(): McpServerStatus {
    return this._status;
  }

  /** Fetch all tools with pagination support. */
  private async listAllTools(): Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>
  > {
    if (!this.client) throw new Error('MCP client is not connected');

    const allTools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }> = [];
    let cursor: string | undefined;

    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined);
      allTools.push(
        ...result.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        })),
      );
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  /** Re-fetch tools and rebuild wrapped tool array. */
  private async rebuildTools(): Promise<void> {
    if (!this.client || !this.callToolFn) return;
    const toolDefs = await this.listAllTools();
    this.tools = toolDefs.map((def) =>
      wrapMcpTool(
        this.config.name,
        { name: def.name, description: def.description, inputSchema: def.inputSchema },
        this.callToolFn!,
        this.toolTimeout,
      ),
    );
    this.logger.info(
      `[mcp:${this.config.name}] tools refreshed, ${this.tools.length} tool(s)`,
    );
    this.onToolsChanged?.(this.config.name, this.tools);
  }

  async start(): Promise<void> {
    const { transport: transportConfig } = this.config;
    this.toolTimeout = this.config.toolTimeout ?? DEFAULT_TOOL_TIMEOUT;

    // Set up OAuth provider if auth is configured
    if (this.config.auth && this.options?.tokenStore) {
      this.authProvider = new DashOAuthClientProvider(
        this.config.name,
        this.options.tokenStore,
        {
          clientId: this.config.auth.clientId,
          clientSecret: this.config.auth.clientSecret,
          scopes: this.config.auth.scopes,
          grantType: this.config.auth.grantType,
          onAuthUrl: this.options.onAuthUrl,
          logger: this.logger,
        },
      );
    }

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
      this.transport = new SSEClientTransport(url, {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(this.authProvider ? { authProvider: this.authProvider } : {}),
      });
    } else if (transportConfig.type === 'streamable-http') {
      const url = new URL(transportConfig.url);
      const headers = transportConfig.headers;
      this.transport = new StreamableHTTPClientTransport(url, {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(this.authProvider ? { authProvider: this.authProvider } : {}),
      });
    } else {
      throw new Error(`Unsupported transport type: ${(transportConfig as { type: string }).type}`);
    }

    this.logger.info(`[mcp:${this.config.name}] connecting...`);
    try {
      await this.client.connect(this.transport);
    } catch (err) {
      if (err instanceof UnauthorizedError && this.authProvider) {
        // Auth code flow: wait for callback, then finish auth and retry
        this.logger.info(`[mcp:${this.config.name}] awaiting OAuth authorization...`);
        const code = await this.authProvider.waitForAuthorizationCode();
        if ('finishAuth' in this.transport) {
          await (
            this.transport as SSEClientTransport | StreamableHTTPClientTransport
          ).finishAuth(code);
        }
        // Retry connection
        await this.client.connect(this.transport);
      } else {
        throw err;
      }
    }

    // Store callTool closure for rebuildTools
    this.callToolFn = async (
      name: string,
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => {
      if (!this.client) {
        throw new Error('MCP client is not connected');
      }
      const res = await this.client.callTool(
        { name, arguments: params },
        undefined,
        options?.signal ? { signal: options.signal } : undefined,
      );
      return res as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    };

    // Discover tools (with pagination)
    await this.rebuildTools();

    // Register tools/list_changed notification handler
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        this.logger.info(`[mcp:${this.config.name}] tools/list_changed notification received`);
        try {
          await this.rebuildTools();
        } catch (err) {
          this.logger.error(
            `[mcp:${this.config.name}] failed to refresh tools: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

    this._status = 'connected';
    this.logger.info(
      `[mcp:${this.config.name}] connected, ${this.tools.length} tool(s) discovered`,
    );
  }

  async stop(): Promise<void> {
    this.logger.info(`[mcp:${this.config.name}] disconnecting...`);
    try {
      if (this.client) {
        await this.client.close();
      }
    } catch (err) {
      this.logger.warn(
        `[mcp:${this.config.name}] error during client close: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      if (this.transport) {
        await this.transport.close();
      }
    } catch (err) {
      this.logger.warn(
        `[mcp:${this.config.name}] error during transport close: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.transport = null;
      this.client = null;
      this.callToolFn = null;
      this.tools = [];
      this._status = 'disconnected';
      this.authProvider?.dispose();
      this.authProvider = null;
    }
  }

  getTools(): AgentTool<TSchema>[] {
    return this.tools;
  }
}
