import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentConfig } from './gateway-client.js';
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

  describe('runtime agent methods', () => {
    const baseConfig: RuntimeAgentConfig = {
      name: 'test-agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
      tools: ['file_read'],
    };

    it('registerRuntimeAgent() calls POST /runtime/agents with config body', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await client.registerRuntimeAgent(baseConfig);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );

      const callArgs = fetchSpy.mock.calls[0][1] as { body: string };
      const body = JSON.parse(callArgs.body);
      expect(body.name).toBe('test-agent');
      expect(body.model).toBe('claude-sonnet-4-20250514');
      expect(body.systemPrompt).toBe('You are a test agent.');
      expect(body.tools).toEqual(['file_read']);
    });

    it('registerRuntimeAgent() throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 409, text: () => Promise.resolve('') });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await expect(client.registerRuntimeAgent(baseConfig)).rejects.toThrow(
        'Gateway registerRuntimeAgent failed: 409',
      );
    });

    it('listRuntimeAgents() calls GET /runtime/agents and returns array', async () => {
      const agents = [{ name: 'a1', config: baseConfig, status: 'active', registeredAt: 1000 }];
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => agents });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      const result = await client.listRuntimeAgents();

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
      // GET is default, so method should not be set
      const callArgs = fetchSpy.mock.calls[0][1] as { method?: string };
      expect(callArgs.method).toBeUndefined();
      expect(result).toEqual(agents);
    });

    it('listRuntimeAgents() throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await expect(client.listRuntimeAgents()).rejects.toThrow(
        'Gateway listRuntimeAgents failed: 500',
      );
    });

    it('getRuntimeAgent() calls GET /runtime/agents/:name', async () => {
      const agent = { name: 'a1', config: baseConfig, status: 'active', registeredAt: 1000 };
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => agent });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      const result = await client.getRuntimeAgent('a1');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents/a1',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
      expect(result).toEqual(agent);
    });

    it('getRuntimeAgent() encodes special characters in name', async () => {
      const agent = {
        name: 'my agent',
        config: baseConfig,
        status: 'registered' as const,
        registeredAt: 1000,
      };
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => agent });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await client.getRuntimeAgent('my agent');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents/my%20agent',
        expect.anything(),
      );
    });

    it('getRuntimeAgent() throws on 404', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await expect(client.getRuntimeAgent('missing')).rejects.toThrow(
        'Gateway getRuntimeAgent failed: 404',
      );
    });

    it('updateRuntimeAgent() calls PUT /runtime/agents/:name with patch body', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await client.updateRuntimeAgent('a1', { model: 'claude-opus-4-20250514' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents/a1',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );

      const callArgs = fetchSpy.mock.calls[0][1] as { body: string };
      const body = JSON.parse(callArgs.body);
      expect(body).toEqual({ model: 'claude-opus-4-20250514' });
    });

    it('removeRuntimeAgent() calls DELETE /runtime/agents/:name', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await client.removeRuntimeAgent('a1');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents/a1',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
    });

    it('removeRuntimeAgent() throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await expect(client.removeRuntimeAgent('missing')).rejects.toThrow(
        'Gateway removeRuntimeAgent failed: 404',
      );
    });

    it('setRuntimeAgentCredentials() calls POST with providerApiKeys', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await client.setRuntimeAgentCredentials('a1', {
        ANTHROPIC_API_KEY: 'sk-ant-123',
        OPENAI_API_KEY: 'sk-oai-456',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents/a1/credentials',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );

      const callArgs = fetchSpy.mock.calls[0][1] as { body: string };
      const body = JSON.parse(callArgs.body);
      expect(body.providerApiKeys).toEqual({
        ANTHROPIC_API_KEY: 'sk-ant-123',
        OPENAI_API_KEY: 'sk-oai-456',
      });
    });

    it('setRuntimeAgentCredentials() throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 400 });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await expect(
        client.setRuntimeAgentCredentials('a1', { ANTHROPIC_API_KEY: 'bad' }),
      ).rejects.toThrow('Gateway setRuntimeAgentCredentials failed: 400');
    });

    it('disableRuntimeAgent() calls POST /runtime/agents/:name/disable', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await client.disableRuntimeAgent('a1');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents/a1/disable',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
    });

    it('enableRuntimeAgent() calls POST /runtime/agents/:name/enable', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await client.enableRuntimeAgent('a1');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9300/runtime/agents/a1/enable',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
    });

    it('enableRuntimeAgent() throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });

      const client = new GatewayManagementClient('http://localhost:9300', 'tok');
      await expect(client.enableRuntimeAgent('missing')).rejects.toThrow(
        'Gateway enableRuntimeAgent failed: 404',
      );
    });
  });
});
