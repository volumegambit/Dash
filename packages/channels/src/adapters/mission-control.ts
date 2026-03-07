import type { IncomingMessage } from 'node:http';
import type { AgentClient, AgentEvent } from '@dash/agent';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

interface McClientMessage {
  type: 'message';
  conversationId: string;
  agentName: string;
  text: string;
}

function validateMessage(data: unknown): data is McClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'message' &&
    typeof msg.conversationId === 'string' &&
    typeof msg.agentName === 'string' &&
    typeof msg.text === 'string'
  );
}

function serializeEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === 'error') {
    return { type: 'error', error: event.error instanceof Error ? event.error.message : String(event.error) };
  }
  // All non-error AgentEvent variants are plain objects safe for JSON serialization.
  return event as Record<string, unknown>;
}

export class MissionControlAdapter {
  readonly name = 'mission-control';
  private wss: WebSocketServer | undefined;
  private connections = new Set<WebSocket>();

  constructor(
    private port: number,
    private agents: Map<string, AgentClient>,
    private token?: string,
  ) {}

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (this.token) {
        const url = new URL(req.url ?? '', 'ws://localhost');
        if (url.searchParams.get('token') !== this.token) {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }

      this.connections.add(ws);
      let closed = false;
      ws.on('close', () => {
        closed = true;
        this.connections.delete(ws);
      });

      // Multiple concurrent messages on the same socket are intentional — the protocol
      // is multiplexed by conversationId so frames from parallel streams may interleave.
      ws.on('message', async (raw) => {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          if (!closed) ws.send(JSON.stringify({ type: 'error', conversationId: '', error: 'Invalid JSON' }));
          return;
        }

        if (!validateMessage(data)) {
          if (!closed) ws.send(JSON.stringify({ type: 'error', conversationId: '', error: 'Invalid message format' }));
          return;
        }

        const agent = this.agents.get(data.agentName);
        if (!agent) {
          if (!closed)
            ws.send(
              JSON.stringify({
                type: 'error',
                conversationId: data.conversationId,
                error: `Unknown agent: ${data.agentName}`,
              }),
            );
          return;
        }

        const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

        try {
          for await (const event of agent.chat('mission-control', data.conversationId, data.text)) {
            if (closed) break;
            ws.send(
              JSON.stringify({
                type: 'event',
                conversationId: data.conversationId,
                event: serializeEvent(event),
              }),
            );
            await flush();
          }
          if (!closed) ws.send(JSON.stringify({ type: 'done', conversationId: data.conversationId }));
        } catch (err) {
          if (!closed)
            ws.send(
              JSON.stringify({
                type: 'error',
                conversationId: data.conversationId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
        }
      });
    });

    const wss = this.wss;
    await new Promise<void>((resolve) => {
      wss.on('listening', resolve);
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.connections) {
      ws.terminate();
    }
    this.connections.clear();

    const wss = this.wss;
    if (wss) {
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      this.wss = undefined;
    }
  }
}
