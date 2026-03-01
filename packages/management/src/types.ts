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

export interface ChannelInfo {
  name: string;
  agent: string;
}

export interface InfoResponse {
  agents: AgentInfo[];
  channels: ChannelInfo[];
}

export interface ShutdownResponse {
  success: true;
}

export interface ErrorResponse {
  error: string;
}
