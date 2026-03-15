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

export interface ChannelHealthEntry {
  appId: string;
  type: 'whatsapp' | 'telegram' | string;
  health: 'connected' | 'connecting' | 'disconnected' | 'needs_reauth';
}

export type ChannelHealthResponse = ChannelHealthEntry[];
