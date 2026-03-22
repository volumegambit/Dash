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

type TransportType = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

export class McpClient {
  private config: McpServerConfig;
  private logger: McpLogger;
  private client: Client | null = null;
  private transport: TransportType | null = null;
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

  // --- Reconnection state ---
  private stopping = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxReconnectAttempts: number;
  private readonly initialReconnectDelay = 1_000;
  private readonly maxReconnectDelay = 30_000;

  constructor(config: McpServerConfig, options?: McpClientOptions) {
    this.logger = options?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.config = interpolateConfigEnvVars(config, this.logger);
    this.options = options;
    this.onToolsChanged = options?.onToolsChanged;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
  }

  get name(): string {
    return this.config.name;
  }

  get status(): McpServerStatus {
    return this._status;
  }

  // --- Transport creation ---

  private createTransport(): TransportType {
    const { transport: transportConfig } = this.config;

    if (transportConfig.type === 'stdio') {
      return new StdioClientTransport({
        command: transportConfig.command,
        args: transportConfig.args,
        env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
      });
    }
    if (transportConfig.type === 'sse') {
      const url = new URL(transportConfig.url);
      const headers = transportConfig.headers;
      return new SSEClientTransport(url, {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(this.authProvider ? { authProvider: this.authProvider } : {}),
      });
    }
    if (transportConfig.type === 'streamable-http') {
      const url = new URL(transportConfig.url);
      const headers = transportConfig.headers;
      return new StreamableHTTPClientTransport(url, {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(this.authProvider ? { authProvider: this.authProvider } : {}),
        reconnectionOptions: {
          maxReconnectionDelay: this.maxReconnectDelay,
          initialReconnectionDelay: this.initialReconnectDelay,
          reconnectionDelayGrowFactor: 2,
          maxRetries: this.maxReconnectAttempts,
        },
      });
    }
    throw new Error(`Unsupported transport type: ${(transportConfig as { type: string }).type}`);
  }

  private setupTransportHandlers(): void {
    if (!this.transport) return;

    this.transport.onerror = (err: Error) => {
      this.logger.error(`[mcp:${this.config.name}] transport error: ${err.message}`);
    };

    this.transport.onclose = () => {
      if (this.stopping) return;
      this.logger.warn(`[mcp:${this.config.name}] transport closed unexpectedly`);
      this.scheduleReconnect();
    };
  }

  // --- Reconnection ---

  private getReconnectDelay(): number {
    return Math.min(
      this.initialReconnectDelay * 2 ** this.reconnectAttempt,
      this.maxReconnectDelay,
    );
  }

  private scheduleReconnect(): void {
    if (this.stopping || this._status === 'error') return;

    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this._status = 'error';
      this.logger.error(
        `[mcp:${this.config.name}] max reconnect attempts (${this.maxReconnectAttempts}) exhausted`,
      );
      return;
    }

    this._status = 'reconnecting';
    const delay = this.getReconnectDelay();
    this.logger.warn(
      `[mcp:${this.config.name}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempt++;
      try {
        this.client = new Client({ name: 'dash-mcp-client', version: '1.0.0' });
        this.transport = this.createTransport();
        this.setupTransportHandlers();
        await this.client.connect(this.transport);
        this.setupCallToolFn();
        this.registerNotificationHandlers();
        await this.rebuildTools();
        this._status = 'connected';
        this.reconnectAttempt = 0;
        this.logger.info(`[mcp:${this.config.name}] reconnected successfully`);
      } catch (err) {
        this.logger.warn(
          `[mcp:${this.config.name}] reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.scheduleReconnect();
      }
    }, delay);
  }

  // --- Tool management ---

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
    this.logger.info(`[mcp:${this.config.name}] tools refreshed, ${this.tools.length} tool(s)`);
    this.onToolsChanged?.(this.config.name, this.tools);
  }

  /** Set up the callTool closure. */
  private setupCallToolFn(): void {
    this.callToolFn = async (
      name: string,
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => {
      if (!this.client) {
        throw new Error('MCP client is not connected');
      }
      if (this._status === 'reconnecting') {
        throw new Error(`MCP server '${this.config.name}' is reconnecting`);
      }
      const res = await this.client.callTool(
        { name, arguments: params },
        undefined,
        options?.signal ? { signal: options.signal } : undefined,
      );
      return res as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    };
  }

  /** Register notification handlers on the client. */
  private registerNotificationHandlers(): void {
    if (!this.client) return;
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
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    this.stopping = false;
    this.reconnectAttempt = 0;
    this.toolTimeout = this.config.toolTimeout ?? DEFAULT_TOOL_TIMEOUT;

    // Set up OAuth provider if auth is configured
    if (this.config.auth && this.options?.tokenStore) {
      this.authProvider = new DashOAuthClientProvider(this.config.name, this.options.tokenStore, {
        clientId: this.config.auth.clientId,
        clientSecret: this.config.auth.clientSecret,
        scopes: this.config.auth.scopes,
        grantType: this.config.auth.grantType,
        onAuthUrl: this.options.onAuthUrl,
        logger: this.logger,
      });
    }

    this.client = new Client({ name: 'dash-mcp-client', version: '1.0.0' });
    this.transport = this.createTransport();
    this.setupTransportHandlers();

    this.logger.info(`[mcp:${this.config.name}] connecting...`);
    try {
      await this.client.connect(this.transport);
    } catch (err) {
      if (err instanceof UnauthorizedError && this.authProvider) {
        this.logger.info(`[mcp:${this.config.name}] awaiting OAuth authorization...`);
        const code = await this.authProvider.waitForAuthorizationCode();
        if ('finishAuth' in this.transport) {
          await (this.transport as SSEClientTransport | StreamableHTTPClientTransport).finishAuth(
            code,
          );
        }
        await this.client.connect(this.transport);
      } else {
        throw err;
      }
    }

    this.setupCallToolFn();
    this.registerNotificationHandlers();
    await this.rebuildTools();

    this._status = 'connected';
    this.logger.info(
      `[mcp:${this.config.name}] connected, ${this.tools.length} tool(s) discovered`,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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
