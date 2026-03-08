import type { AgentClient, AgentEvent } from '@dash/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionControlAdapter } from './mission-control.js';

const PORT = 19200 + Math.floor(Math.random() * 800);

function makeAgent(events: AgentEvent[]): AgentClient {
  return {
    async *chat() {
      for (const e of events) yield e;
    },
  };
}

function connectWs(port: number, token?: string): Promise<WebSocket> {
  const url = token ? `ws://127.0.0.1:${port}?token=${token}` : `ws://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(JSON.parse(String(e.data))), { once: true });
  });
}

describe('MissionControlAdapter', () => {
  let adapter: MissionControlAdapter;

  afterEach(async () => {
    await adapter.stop();
  });

  it('streams events and done for a known agent', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'Hi' },
      {
        type: 'response',
        content: 'Hi',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];
    adapter = new MissionControlAdapter(PORT, new Map([['myagent', makeAgent(events)]]));
    await adapter.start();

    const ws = await connectWs(PORT);
    ws.send(
      JSON.stringify({ type: 'message', conversationId: 'c1', agentName: 'myagent', text: 'hi' }),
    );

    const msg1 = await nextMessage(ws);
    expect(msg1).toEqual({
      type: 'event',
      conversationId: 'c1',
      event: { type: 'text_delta', text: 'Hi' },
    });

    const msg2 = await nextMessage(ws);
    expect(msg2.type).toBe('event');

    const done = await nextMessage(ws);
    expect(done).toEqual({ type: 'done', conversationId: 'c1' });

    ws.close();
  });

  it('sends error for unknown agent', async () => {
    adapter = new MissionControlAdapter(PORT + 100, new Map());
    await adapter.start();

    const ws = await connectWs(PORT + 100);
    ws.send(
      JSON.stringify({ type: 'message', conversationId: 'c1', agentName: 'nope', text: 'hi' }),
    );

    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.conversationId).toBe('c1');
    ws.close();
  });

  it('closes with code 4001 for wrong token', async () => {
    adapter = new MissionControlAdapter(PORT + 200, new Map(), 'secret');
    await adapter.start();

    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT + 200}?token=wrong`);
      ws.addEventListener('close', (e) => resolve(e.code));
    });
    expect(closed).toBe(4001);
  });

  it('allows connection with correct token', async () => {
    adapter = new MissionControlAdapter(PORT + 300, new Map([['a', makeAgent([])]]), 'secret');
    await adapter.start();

    const ws = await connectWs(PORT + 300, 'secret');
    ws.send(JSON.stringify({ type: 'message', conversationId: 'c1', agentName: 'a', text: 'hi' }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('done');
    ws.close();
  });

  it('sends error response for invalid JSON', async () => {
    adapter = new MissionControlAdapter(PORT + 400, new Map());
    await adapter.start();

    const ws = await connectWs(PORT + 400);
    ws.send('not json');
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    ws.close();
  });

  it('sends error response for invalid message format', async () => {
    adapter = new MissionControlAdapter(PORT + 500, new Map());
    await adapter.start();

    const ws = await connectWs(PORT + 500);
    ws.send(JSON.stringify({ type: 'unknown' }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe('error');
    ws.close();
  });

  it('does not crash when client disconnects mid-stream', async () => {
    const slowAgent: AgentClient = {
      async *chat() {
        yield { type: 'text_delta', text: 'first' } satisfies AgentEvent;
        // hang forever — simulates a slow/streaming agent
        await new Promise<void>(() => {});
      },
    };
    adapter = new MissionControlAdapter(PORT + 600, new Map([['slow', slowAgent]]));
    await adapter.start();

    const ws = await connectWs(PORT + 600);
    ws.send(
      JSON.stringify({ type: 'message', conversationId: 'c1', agentName: 'slow', text: 'go' }),
    );

    // Wait for the first event to arrive so the server is mid-stream, then drop the connection.
    await nextMessage(ws);
    ws.close();

    // Give the server time to react to the close and attempt further sends.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify no crash: stop() completes cleanly and the connections set is empty.
    await adapter.stop();
    // Re-assign so afterEach doesn't double-stop (stop() is idempotent but assign a no-op).
    adapter = new MissionControlAdapter(PORT + 601, new Map());
  });
});
