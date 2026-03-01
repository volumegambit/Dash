import type { AgentClient, AgentEvent } from '@dash/agent';

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

// --- WebSocket Chat API ---

export type WsClientMessage =
  | {
      type: 'message';
      id: string;
      agent: string;
      channelId: string;
      conversationId: string;
      text: string;
    }
  | { type: 'cancel'; id: string };

export type WsServerMessage =
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; error: string };

export interface ChatServerOptions {
  port: number;
  token: string;
  agents: Map<string, AgentClient>;
}
