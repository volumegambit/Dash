import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAgentRequest, GatewayAgent, GatewayChannel } from './gateway-client.js';
import { GatewayManagementClient } from './gateway-client.js';

const BASE_URL = 'http://localhost:9300';
const TOKEN = 'test-token';

const AUTH_HEADER = { Authorization: `Bearer ${TOKEN}` };

function makeAgent(overrides?: Partial<GatewayAgent>): GatewayAgent {
  return {
    id: 'agent-123',
    name: 'test-agent',
    config: {
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
      tools: ['file_read'],
    },
    status: 'registered',
    registeredAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

function makeChannel(overrides?: Partial<GatewayChannel>): GatewayChannel {
  return {
    name: 'my-channel',
    adapter: 'telegram',
    globalDenyList: [],
    routing: [{ condition: { type: 'default' }, agentId: 'agent-123', allowList: [], denyList: [] }],
    registeredAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('GatewayManagementClient', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  function mockOk(body?: unknown) {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? {}),
    });
  }

  function mockError(status: number, body = '') {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => body,
    });
  }

  // ---- Health ----

  describe('health()', () => {
    it('calls GET /health without auth headers', async () => {
      mockOk({ status: 'healthy', startedAt: '2026-04-01T00:00:00Z', agents: 2, channels: 1 });

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.health();

      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/health`);
      expect(result.status).toBe('healthy');
      expect(result.agents).toBe(2);
      expect(result.channels).toBe(1);
    });
  });

  // ---- Agents ----

  describe('createAgent()', () => {
    const req: CreateAgentRequest = {
      name: 'my-agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You help users.',
      tools: ['file_read'],
    };

    it('calls POST /agents with body and auth headers', async () => {
      const agent = makeAgent();
      mockOk(agent);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.createAgent(req);

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body.name).toBe('my-agent');
      expect(body.model).toBe('claude-sonnet-4-20250514');
      expect(result).toEqual(agent);
    });

    it('throws descriptive error on non-ok response', async () => {
      mockError(409, 'Agent already exists');

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.createAgent(req)).rejects.toThrow('Gateway createAgent failed: 409 Agent already exists');
    });
  });

  describe('listAgents()', () => {
    it('calls GET /agents with auth headers and returns array', async () => {
      const agents = [makeAgent()];
      mockOk(agents);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.listAgents();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
      expect(result).toEqual(agents);
    });

    it('throws on non-ok response', async () => {
      mockError(500);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.listAgents()).rejects.toThrow('Gateway listAgents failed: 500');
    });
  });

  describe('getAgent()', () => {
    it('calls GET /agents/:id with auth headers', async () => {
      const agent = makeAgent();
      mockOk(agent);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.getAgent('agent-123');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents/agent-123`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
      expect(result).toEqual(agent);
    });

    it('encodes special characters in id', async () => {
      mockOk(makeAgent({ id: 'my agent' }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.getAgent('my agent');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents/my%20agent`,
        expect.anything(),
      );
    });

    it('throws on 404', async () => {
      mockError(404, 'not found');

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.getAgent('missing')).rejects.toThrow('Gateway getAgent failed: 404 not found');
    });
  });

  describe('updateAgent()', () => {
    it('calls PUT /agents/:id with patch body and returns updated agent', async () => {
      const updated = makeAgent({ config: { model: 'claude-opus-4-20250514', systemPrompt: 'Updated.' } });
      mockOk(updated);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.updateAgent('agent-123', { model: 'claude-opus-4-20250514' });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents/agent-123`,
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body).toEqual({ model: 'claude-opus-4-20250514' });
      expect(result).toEqual(updated);
    });

    it('throws on non-ok response', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.updateAgent('missing', {})).rejects.toThrow('Gateway updateAgent failed: 404');
    });
  });

  describe('removeAgent()', () => {
    it('calls DELETE /agents/:id with auth headers', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.removeAgent('agent-123');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents/agent-123`,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
    });

    it('throws on non-ok response', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.removeAgent('missing')).rejects.toThrow('Gateway removeAgent failed: 404');
    });
  });

  describe('disableAgent()', () => {
    it('calls POST /agents/:id/disable with auth headers', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.disableAgent('agent-123');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents/agent-123/disable`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
    });

    it('throws on non-ok response', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.disableAgent('missing')).rejects.toThrow('Gateway disableAgent failed: 404');
    });
  });

  describe('enableAgent()', () => {
    it('calls POST /agents/:id/enable with auth headers', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.enableAgent('agent-123');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/agents/agent-123/enable`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
    });

    it('throws on non-ok response', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.enableAgent('missing')).rejects.toThrow('Gateway enableAgent failed: 404');
    });
  });

  // ---- Channels ----

  describe('registerChannel()', () => {
    it('calls POST /channels with body and auth headers', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.registerChannel({
        name: 'my-channel',
        adapter: 'telegram',
        globalDenyList: ['spammer'],
        routing: [{ condition: { type: 'default' }, agentId: 'agent-123', allowList: [], denyList: [] }],
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/channels`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body.name).toBe('my-channel');
      expect(body.adapter).toBe('telegram');
      expect(body.globalDenyList).toEqual(['spammer']);
    });

    it('throws on non-ok response', async () => {
      mockError(400, 'invalid config');

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(
        client.registerChannel({ name: 'bad', adapter: 'telegram', routing: [] }),
      ).rejects.toThrow('Gateway registerChannel failed: 400 invalid config');
    });
  });

  describe('listChannels()', () => {
    it('calls GET /channels with auth headers and returns array', async () => {
      const channels = [makeChannel()];
      mockOk(channels);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.listChannels();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/channels`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
      expect(result).toEqual(channels);
    });

    it('throws on non-ok response', async () => {
      mockError(500);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.listChannels()).rejects.toThrow('Gateway listChannels failed: 500');
    });
  });

  describe('getChannel()', () => {
    it('calls GET /channels/:name with auth headers', async () => {
      const channel = makeChannel();
      mockOk(channel);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.getChannel('my-channel');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/channels/my-channel`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
      expect(result).toEqual(channel);
    });

    it('encodes special characters in name', async () => {
      mockOk(makeChannel({ name: 'my channel' }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.getChannel('my channel');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/channels/my%20channel`,
        expect.anything(),
      );
    });

    it('throws on 404', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.getChannel('missing')).rejects.toThrow('Gateway getChannel failed: 404');
    });
  });

  describe('updateChannel()', () => {
    it('calls PUT /channels/:name with patch body', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.updateChannel('my-channel', { globalDenyList: ['user1'] });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/channels/my-channel`,
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body).toEqual({ globalDenyList: ['user1'] });
    });

    it('throws on non-ok response', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.updateChannel('missing', {})).rejects.toThrow('Gateway updateChannel failed: 404');
    });
  });

  describe('removeChannel()', () => {
    it('calls DELETE /channels/:name with auth headers', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.removeChannel('my-channel');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/channels/my-channel`,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
    });

    it('throws on non-ok response', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.removeChannel('missing')).rejects.toThrow('Gateway removeChannel failed: 404');
    });
  });

  // ---- Credentials ----

  describe('setCredential()', () => {
    it('calls POST /credentials with key/value body and auth headers', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.setCredential('ANTHROPIC_API_KEY', 'sk-ant-123');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/credentials`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body).toEqual({ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-123' });
    });

    it('throws on non-ok response', async () => {
      mockError(400, 'invalid key');

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.setCredential('', 'val')).rejects.toThrow('Gateway setCredential failed: 400 invalid key');
    });
  });

  describe('listCredentials()', () => {
    it('calls GET /credentials with auth headers and returns array of keys', async () => {
      mockOk(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.listCredentials();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/credentials`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
      expect(result).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    });

    it('throws on non-ok response', async () => {
      mockError(403);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.listCredentials()).rejects.toThrow('Gateway listCredentials failed: 403');
    });
  });

  describe('removeCredential()', () => {
    it('calls DELETE /credentials/:key with auth headers', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.removeCredential('ANTHROPIC_API_KEY');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/credentials/ANTHROPIC_API_KEY`,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining(AUTH_HEADER),
        }),
      );
    });

    it('encodes special characters in key', async () => {
      mockOk();

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.removeCredential('my key/with:special');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/credentials/my%20key%2Fwith%3Aspecial`,
        expect.anything(),
      );
    });

    it('throws on non-ok response', async () => {
      mockError(404);

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.removeCredential('missing')).rejects.toThrow('Gateway removeCredential failed: 404');
    });
  });
});
