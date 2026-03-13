import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayManagementClient } from './gateway-client.js';

describe('GatewayManagementClient', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('health() returns parsed body', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'healthy',
        startedAt: '2026-03-08T00:00:00Z',
        agents: 0,
        channels: 0,
      }),
    });

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    const result = await client.health();
    expect(result.status).toBe('healthy');
    expect(result.startedAt).toBe('2026-03-08T00:00:00Z');
  });

  it('registerAgent() calls POST /agents with auth header', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    await client.registerAgent('dep1', 'default', 'ws://localhost:9101/ws', 'chat-tok');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:9300/agents',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );

    const callArgs = fetchSpy.mock.calls[0][1] as { body: string };
    const body = JSON.parse(callArgs.body);
    expect(body.deploymentId).toBe('dep1');
    expect(body.agentName).toBe('default');
    expect(body.chatUrl).toBe('ws://localhost:9101/ws');
    expect(body.chatToken).toBe('chat-tok');
  });

  it('deregisterDeployment() calls DELETE /deployments/:id', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    await client.deregisterDeployment('dep1');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:9300/deployments/dep1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deregisterDeployment() swallows network errors', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    await expect(client.deregisterDeployment('dep1')).resolves.toBeUndefined();
  });

  it('registerChannel() calls POST /channels with correct body', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    await client.registerChannel('dep1', 'tg1', {
      adapter: 'telegram',
      token: 'bot-tok',
      globalDenyList: [],
      routing: [
        { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
      ],
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:9300/channels',
      expect.objectContaining({ method: 'POST' }),
    );

    const callArgs = fetchSpy.mock.calls[0][1] as { body: string };
    const body = JSON.parse(callArgs.body);
    expect(body.deploymentId).toBe('dep1');
    expect(body.channelName).toBe('tg1');
    expect(body.config.adapter).toBe('telegram');
  });

  it('registerAgent() throws on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    await expect(
      client.registerAgent('dep1', 'default', 'ws://localhost:9101/ws', 'tok'),
    ).rejects.toThrow('Gateway registerAgent failed: 500');
  });

  it('registerChannel() throws on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Bad request' }),
    });

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    await expect(
      client.registerChannel('dep1', 'tg1', {
        adapter: 'telegram',
        token: 'bot-tok',
        globalDenyList: [],
        routing: [],
      }),
    ).rejects.toThrow('Gateway registerChannel failed: 400');
  });

  it('deregisterDeployment() swallows non-ok HTTP responses', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });

    const client = new GatewayManagementClient('http://localhost:9300', 'tok');
    // Should not throw even on non-ok response
    await expect(client.deregisterDeployment('dep1')).resolves.toBeUndefined();
  });
});
