import type { AgentClient, AgentEvent, Logger } from '@dash/agent';

export interface WsMessageImage {
  mediaType: string;
  data: string;
}

export type WsClientMessage =
  | {
      type: 'message';
      id: string;
      agent: string;
      channelId: string;
      conversationId: string;
      text: string;
      images?: WsMessageImage[];
    }
  | { type: 'cancel'; id: string }
  | { type: 'answer'; id: string; questionId: string; answer: string };

export type WsServerMessage =
  | { type: 'event'; id: string; event: AgentEvent }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; error: string };

export interface ChatServerOptions {
  port: number;
  token: string;
  agents: Map<string, AgentClient>;
  logger?: Logger;
}
