import { randomUUID } from 'node:crypto';
import type { AgentRegistry, ConversationStore, McConversation, McMessage } from '@dash/mc';
import WebSocket from 'ws';
import type { McAgentEvent } from '../shared/ipc.js';

export interface GatewayConnection {
  channelPort: number;
  chatToken?: string;
}

export class ChatService {
  private activeStreams = new Map<string, { ws: WebSocket; msgId: string }>();

  constructor(
    private registry: AgentRegistry,
    private store: ConversationStore,
    private onEvent: (conversationId: string, event: McAgentEvent) => void,
    private onDone: (conversationId: string) => void,
    private onError: (conversationId: string, error: string) => void,
    private gatewayConnection?: GatewayConnection,
  ) {}

  setGatewayConnection(connection: GatewayConnection): void {
    this.gatewayConnection = connection;
  }

  async createConversation(deploymentId: string, agentName: string): Promise<McConversation> {
    return this.store.create(deploymentId, agentName);
  }

  async listConversations(deploymentId: string): Promise<McConversation[]> {
    return this.store.list(deploymentId);
  }

  async listAllConversations(): Promise<McConversation[]> {
    return this.store.listAll();
  }

  async getMessages(conversationId: string): Promise<McMessage[]> {
    return this.store.getMessages(conversationId);
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    return this.store.rename(conversationId, title);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.cancel(conversationId);
    return this.store.delete(conversationId);
  }

  async sendMessage(
    conversationId: string,
    text: string,
    images?: { mediaType: string; data: string }[],
  ): Promise<void> {
    const conversation = await this.store.get(conversationId);
    if (!conversation) throw new Error(`Conversation "${conversationId}" not found`);

    if (this.activeStreams.has(conversationId)) {
      throw new Error(`Conversation "${conversationId}" already has an active stream`);
    }

    const deployment = await this.registry.get(conversation.deploymentId);
    if (!deployment) throw new Error(`Deployment "${conversation.deploymentId}" not found`);
    if (deployment.status !== 'running') {
      throw new Error(`Deployment "${conversation.deploymentId}" is not running`);
    }

    const userMessage: McMessage = {
      id: randomUUID(),
      role: 'user',
      content: { type: 'user', text, ...(images?.length ? { images } : {}) },
      timestamp: new Date().toISOString(),
    };
    await this.store.appendMessage(conversationId, userMessage);

    if (!this.gatewayConnection) throw new Error('Gateway connection not configured');
    const { channelPort, chatToken } = this.gatewayConnection;
    const url = `ws://localhost:${channelPort}/ws/chat${chatToken ? `?token=${encodeURIComponent(chatToken)}` : ''}`;
    const msgId = randomUUID();
    const ws = new WebSocket(url);
    this.activeStreams.set(conversationId, { ws, msgId });

    const accumulatedEvents: McAgentEvent[] = [];

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: msgId,
          type: 'message',
          agent: conversation.agentName,
          channelId: 'mission-control',
          conversationId,
          text,
          ...(images?.length ? { images } : {}),
        }),
      );
    });

    ws.addEventListener('message', (event) => {
      let msg: { type: string; id: string; event?: McAgentEvent; error?: string };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return; // ignore malformed JSON
      }

      if (msg.id !== msgId) return;

      if (msg.type === 'event' && msg.event) {
        accumulatedEvents.push(msg.event);
        this.onEvent(conversationId, msg.event);
      } else if (msg.type === 'done') {
        this.activeStreams.delete(conversationId);
        ws.close();
        // Save assistant message — best-effort, don't block onDone
        const assistantMessage: McMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: { type: 'assistant', events: accumulatedEvents },
          timestamp: new Date().toISOString(),
        };
        this.store.appendMessage(conversationId, assistantMessage).catch((err) => {
          console.error('[ChatService] Failed to persist assistant message:', err);
        });
        this.onDone(conversationId);
      } else if (msg.type === 'error') {
        this.activeStreams.delete(conversationId);
        ws.close();
        this.onError(conversationId, msg.error ?? 'Unknown error');
      }
    });

    ws.addEventListener('error', () => {
      if (this.activeStreams.has(conversationId)) {
        this.activeStreams.delete(conversationId);
        this.onError(conversationId, 'WebSocket connection error');
      }
    });

    ws.addEventListener('close', () => {
      if (this.activeStreams.has(conversationId)) {
        // Closed unexpectedly — save partial events if any
        this.activeStreams.delete(conversationId);
        if (accumulatedEvents.length > 0) {
          const partialMessage: McMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: { type: 'assistant', events: accumulatedEvents },
            timestamp: new Date().toISOString(),
          };
          this.store.appendMessage(conversationId, partialMessage).catch((err) => {
            console.error('[ChatService] Failed to save partial message:', err);
          });
        }
      }
    });
  }

  cancel(conversationId: string): void {
    const entry = this.activeStreams.get(conversationId);
    if (entry) {
      this.activeStreams.delete(conversationId);
      entry.ws.close();
    }
  }

  answerQuestion(conversationId: string, questionId: string, answer: string): void {
    const entry = this.activeStreams.get(conversationId);
    if (!entry) {
      throw new Error(`No active stream for conversation "${conversationId}"`);
    }
    entry.ws.send(
      JSON.stringify({
        type: 'answer',
        id: entry.msgId,
        questionId,
        answer,
      }),
    );
  }
}
