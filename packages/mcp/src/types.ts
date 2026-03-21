// --- Logger interface (minimal, compatible with both @dash/logging and agent's Logger) ---

export interface McpLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

// --- Transport configs ---

export interface StdioTransportConfig {
  type: 'stdio';
  command: string;
  args?: string[];
}

export interface SseTransportConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface StreamableHttpTransportConfig {
  type: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

export type TransportConfig =
  | StdioTransportConfig
  | SseTransportConfig
  | StreamableHttpTransportConfig;

// --- Auth ---

export interface McpServerAuth {
  type: 'oauth';
  grantType?: 'authorization_code' | 'client_credentials';
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}

// --- Server config ---

/** Regex for valid server names: alphanumeric, hyphens, underscores, no double-underscore */
export const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const NAMESPACE_SEPARATOR = '__';
export const DEFAULT_TOOL_TIMEOUT = 60_000;

export interface McpServerConfig {
  name: string;
  transport: TransportConfig;
  env?: Record<string, string>;
  auth?: McpServerAuth;
  toolTimeout?: number;
}

export type McpServerStatus = 'connected' | 'disconnected' | 'error';

// --- Token storage (pluggable) ---

export interface TokenStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private store = new Map<string, string>();

  async get(key: string) {
    return this.store.get(key);
  }

  async set(key: string, value: string) {
    this.store.set(key, value);
  }

  async delete(key: string) {
    this.store.delete(key);
  }
}
