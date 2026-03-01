import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { ChannelAdapter, InboundMessage, MessageHandler, OutboundMessage } from '../types.js';

interface McClientMessage {
  type: 'message';
  conversationId: string;
  text: string;
}

function validateMessage(data: unknown): data is McClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'message' && typeof msg.conversationId === 'string' && typeof msg.text === 'string'
  );
}

export class MissionControlAdapter implements ChannelAdapter {
  readonly name = 'mission-control';
  private handlers: MessageHandler[] = [];
  private wss: WebSocketServer | undefined;
  private clients = new Map<string, WebSocket>();

  constructor(private port: number) {}

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws) => {
      ws.on('message', async (raw) => {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: 'error', conversationId: '', error: 'Invalid JSON' }));
          return;
        }

        if (!validateMessage(data)) {
          ws.send(
            JSON.stringify({ type: 'error', conversationId: '', error: 'Invalid message format' }),
          );
          return;
        }

        this.clients.set(data.conversationId, ws);

        const msg: InboundMessage = {
          channelId: 'mission-control',
          conversationId: data.conversationId,
          senderId: 'mc',
          senderName: 'Mission Control',
          text: data.text,
          timestamp: new Date(),
        };

        for (const handler of this.handlers) {
          await handler(msg);
        }
      });

      ws.on('close', () => {
        for (const [convId, client] of this.clients) {
          if (client === ws) {
            this.clients.delete(convId);
          }
        }
      });
    });

    const wss = this.wss;
    await new Promise<void>((resolve) => {
      wss.on('listening', resolve);
    });

    console.log(`Mission Control adapter listening on port ${this.port}`);
  }

  async stop(): Promise<void> {
    for (const ws of this.clients.values()) {
      ws.close();
    }
    this.clients.clear();

    const wss = this.wss;
    if (wss) {
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      this.wss = undefined;
    }
  }

  async send(conversationId: string, message: OutboundMessage): Promise<void> {
    const ws = this.clients.get(conversationId);
    if (!ws) return;
    ws.send(JSON.stringify({ type: 'response', conversationId, text: message.text }));
  }
}
