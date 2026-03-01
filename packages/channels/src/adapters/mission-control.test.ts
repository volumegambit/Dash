import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionControlAdapter } from './mission-control.js';

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener(
      'message',
      (event) => {
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
  });
}

describe('MissionControlAdapter', () => {
  let adapter: MissionControlAdapter;
  const port = 19200 + Math.floor(Math.random() * 1000);

  beforeEach(async () => {
    adapter = new MissionControlAdapter(port);
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it('receives messages from WS clients', async () => {
    const received: { channelId: string; conversationId: string; text: string }[] = [];
    adapter.onMessage(async (msg) => {
      received.push({
        channelId: msg.channelId,
        conversationId: msg.conversationId,
        text: msg.text,
      });
    });

    await adapter.start();
    const ws = await connectWs(port);

    ws.send(JSON.stringify({ type: 'message', conversationId: 'conv-1', text: 'hello' }));

    // Wait for handler to process
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      channelId: 'mission-control',
      conversationId: 'conv-1',
      text: 'hello',
    });

    ws.close();
  });

  it('sends responses to the correct client', async () => {
    adapter.onMessage(async () => {});
    await adapter.start();

    const ws = await connectWs(port);
    ws.send(JSON.stringify({ type: 'message', conversationId: 'conv-1', text: 'hi' }));
    await new Promise((r) => setTimeout(r, 50));

    const responsePromise = waitForMessage(ws);
    await adapter.send('conv-1', { text: 'Hello back!' });
    const response = await responsePromise;

    expect(response).toEqual({
      type: 'response',
      conversationId: 'conv-1',
      text: 'Hello back!',
    });

    ws.close();
  });

  it('handles invalid JSON gracefully', async () => {
    await adapter.start();
    const ws = await connectWs(port);

    const responsePromise = waitForMessage(ws);
    ws.send('not json');
    const response = await responsePromise;

    expect(response.type).toBe('error');
    expect(response.error).toBe('Invalid JSON');

    ws.close();
  });

  it('handles invalid message format', async () => {
    await adapter.start();
    const ws = await connectWs(port);

    const responsePromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'unknown' }));
    const response = await responsePromise;

    expect(response.type).toBe('error');
    expect(response.error).toBe('Invalid message format');

    ws.close();
  });

  it('cleans up client on disconnect', async () => {
    adapter.onMessage(async () => {});
    await adapter.start();

    const ws = await connectWs(port);
    ws.send(JSON.stringify({ type: 'message', conversationId: 'conv-1', text: 'hi' }));
    await new Promise((r) => setTimeout(r, 50));

    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    // send() to disconnected client should not throw
    await adapter.send('conv-1', { text: 'should not throw' });
  });
});
