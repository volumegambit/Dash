import { randomUUID } from 'node:crypto';
import type { AgentClient, AgentEvent } from '@dash/agent';
import type { WsClientMessage, WsServerMessage } from './types.js';

// Node 22 provides WebSocket globally but TS ES2024 lib doesn't include its types
declare const WebSocket: {
  new (url: string): WebSocket;
  readonly OPEN: number;
  readonly CONNECTING: number;
};
interface WebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
}

export class RemoteAgentClient implements AgentClient {
  constructor(
    private wsUrl: string,
    private token: string,
    private agentName: string,
  ) {}

  async *chat(channelId: string, conversationId: string, text: string): AsyncGenerator<AgentEvent> {
    const id = randomUUID();
    const url = `${this.wsUrl}?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);

    // Queue for events received from the server
    const queue: Array<WsServerMessage | Error> = [];
    let resolve: (() => void) | null = null;
    let done = false;

    function push(item: WsServerMessage | Error) {
      queue.push(item);
      if (resolve) {
        resolve();
        resolve = null;
      }
    }

    ws.addEventListener('open', () => {
      const msg: WsClientMessage = {
        type: 'message',
        id,
        agent: this.agentName,
        channelId,
        conversationId,
        text,
      };
      ws.send(JSON.stringify(msg));
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as WsServerMessage;
        push(msg);
      } catch {
        push(new Error('Invalid JSON from server'));
      }
    });

    ws.addEventListener('error', () => {
      push(new Error('WebSocket connection error'));
    });

    ws.addEventListener('close', (event) => {
      if (!done) {
        push(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
      }
    });

    try {
      while (true) {
        while (queue.length === 0) {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }

        const item = queue.shift();
        if (!item) continue;

        if (item instanceof Error) {
          yield { type: 'error', error: item };
          return;
        }

        // Only process messages matching our correlation id
        if (item.id !== id) continue;

        if (item.type === 'event') {
          yield item.event;
        } else if (item.type === 'done') {
          return;
        } else if (item.type === 'error') {
          yield { type: 'error', error: new Error(item.error) };
          return;
        }
      }
    } finally {
      done = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }
}
