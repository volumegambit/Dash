export interface HealthResponse {
  status: 'healthy';
  uptime: number;
  version: string;
}

export interface AgentInfo {
  name: string;
  model: string;
  tools: string[];
}

export interface InfoResponse {
  agents: AgentInfo[];
}

export interface ShutdownResponse {
  success: true;
}

export interface ErrorResponse {
  error: string;
}

export interface LogsResponse {
  lines: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  location: string; // file path or URL
  editable: boolean; // true for local file paths, false for URL-sourced
  source?: 'managed' | 'agent' | 'remote';
}

export interface SkillContent extends SkillInfo {
  content: string; // full SKILL.md text
}

export interface SkillsConfig {
  paths: string[];
  urls: string[];
}

export interface ChannelHealthEntry {
  appId: string;
  type: 'whatsapp' | 'telegram' | string;
  health: 'connected' | 'connecting' | 'disconnected' | 'needs_reauth';
}

export type ChannelHealthResponse = ChannelHealthEntry[];

// --- MCP Connectors ---

export interface McpServerInfo {
  name: string;
  transport: { type: string; url?: string; command?: string; args?: string[] };
  status: 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'needs_reauth';
  tools: string[];
}

export interface McpAddServerRequest {
  name: string;
  transport:
    | { type: 'stdio'; command: string; args?: string[] }
    | { type: 'sse'; url: string; headers?: Record<string, string> }
    | { type: 'streamable-http'; url: string; headers?: Record<string, string> };
  env?: Record<string, string>;
  auth?: {
    type: 'oauth';
    grantType?: 'authorization_code' | 'client_credentials';
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
  };
  toolTimeout?: number;
}

export interface McpAddServerResponse {
  status: 'connected' | 'awaiting_authorization';
  serverName: string;
  tools?: string[];
  authUrl?: string;
}
