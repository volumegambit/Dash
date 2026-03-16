export interface HealthResponse {
  status: 'healthy';
  uptime: number;
  version: string;
}

export interface AgentInfo {
  name: string;
  model: string;
  tools: string[];
  mcpServers?: string[];
}

export interface McpServerInfo {
  name: string;
  status: string;
  error?: string;
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
