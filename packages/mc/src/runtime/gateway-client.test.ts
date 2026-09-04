import { readFile } from 'node:fs/promises';
import type {
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  GatewayIdentity,
  MobileApiError,
  ReplayPage,
} from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateAgentRequest,
  GatewayAgent,
  GatewayChannel,
  GatewayHealthResponse,
} from './gateway-client.js';
import {
  GatewayHttpError,
  GatewayManagementClient,
  InvalidGatewayLanTlsFingerprintError,
} from './gateway-client.js';

const BASE_URL = 'http://localhost:9300';
const TOKEN = 'test-token';

const AUTH_HEADER = { Authorization: `Bearer ${TOKEN}` };

async function fixture<T>(name: string): Promise<T> {
  const url = new URL(`../../../../contracts/mobile/v1/fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as T;
}

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
    allowedUsers: [],
    routing: [
      { condition: { type: 'default' }, agentId: 'agent-123', allowList: [], denyList: [] },
    ],
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
    fetchSpy.mockResolvedValueOnce(new Response(body, { status }));
  }

  // ---- Health ----

  describe('health()', () => {
    it('calls GET /health without auth headers and with a short timeout', async () => {
      mockOk({ status: 'healthy', startedAt: '2026-04-01T00:00:00Z', agents: 2, channels: 1 });

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.health();

      // URL must match; options must include an AbortSignal (the
      // short-timeout abort for the hot path). We don't assert on the
      // exact timeout value — that's an implementation detail — only
      // that a signal is present so the call is bounded.
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/health`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(result.status).toBe('healthy');
      expect(result.agents).toBe(2);
      expect(result.channels).toBe(1);
    });

    it('throws GatewayHttpError with the status on non-2xx responses', async () => {
      // Important for GatewaySupervisor's error-classification logic:
      // a 401 here must be distinguishable from a fetch timeout so
      // that only permanent mismatches trigger a respawn.
      const { GatewayHttpError } = await import('./gateway-client.js');
      mockError(500, 'internal error');

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.health()).rejects.toBeInstanceOf(GatewayHttpError);
    });

    it('includes extra relay headers on health checks', async () => {
      mockOk({ status: 'healthy', startedAt: '2026-04-01T00:00:00Z', agents: 0, channels: 0 });

      const client = new GatewayManagementClient(BASE_URL, TOKEN, {
        'x-dash-relay-credential': 'relay-cred',
      });
      await client.health();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/health`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-dash-relay-credential': 'relay-cred' }),
        }),
      );
    });
  });

  describe('getRelayIdentity()', () => {
    it('calls GET /identity with auth headers and returns { publicKey }', async () => {
      mockOk({ publicKey: 'ed25519-pubkey-b64' });

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.getRelayIdentity();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/identity`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
      expect(result.publicKey).toBe('ed25519-pubkey-b64');
    });

    it('throws GatewayHttpError on non-2xx', async () => {
      const { GatewayHttpError } = await import('./gateway-client.js');
      mockError(404, 'not found');

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.getRelayIdentity()).rejects.toBeInstanceOf(GatewayHttpError);
    });
  });

  describe('getLanTlsFingerprint()', () => {
    it('calls the admin-only LAN TLS route and returns the certificate fingerprint', async () => {
      mockOk({ certificateSha256: 'b'.repeat(64) });

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const result = await client.getLanTlsFingerprint();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/lan-tls`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
      expect(result).toBe('b'.repeat(64));
    });

    it('rejects a malformed fingerprint as an explicit capability error', async () => {
      mockOk({ certificateSha256: 'not-a-sha256-fingerprint' });

      const client = new GatewayManagementClient(BASE_URL, TOKEN);

      await expect(client.getLanTlsFingerprint()).rejects.toBeInstanceOf(
        InvalidGatewayLanTlsFingerprintError,
      );
    });

    it('rejects a non-JSON capability response as the same explicit error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('legacy route response', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      const client = new GatewayManagementClient(BASE_URL, TOKEN);

      await expect(client.getLanTlsFingerprint()).rejects.toBeInstanceOf(
        InvalidGatewayLanTlsFingerprintError,
      );
    });

    it('rejects a null JSON capability response as the same explicit error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = new GatewayManagementClient(BASE_URL, TOKEN);

      await expect(client.getLanTlsFingerprint()).rejects.toBeInstanceOf(
        InvalidGatewayLanTlsFingerprintError,
      );
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
      await expect(client.createAgent(req)).rejects.toThrow(
        'Gateway createAgent failed: 409 Agent already exists',
      );
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

      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/agents/my%20agent`, expect.anything());
    });

    it('throws on 404', async () => {
      mockError(404, 'not found');

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.getAgent('missing')).rejects.toThrow(
        'Gateway getAgent failed: 404 not found',
      );
    });
  });

  describe('updateAgent()', () => {
    it('calls PUT /agents/:id with patch body and returns updated agent', async () => {
      const updated = makeAgent({
        config: { model: 'claude-opus-4-20250514', systemPrompt: 'Updated.' },
      });
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
      await expect(client.updateAgent('missing', {})).rejects.toThrow(
        'Gateway updateAgent failed: 404',
      );
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
      await expect(client.removeAgent('missing')).rejects.toThrow(
        'Gateway removeAgent failed: 404',
      );
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
      await expect(client.disableAgent('missing')).rejects.toThrow(
        'Gateway disableAgent failed: 404',
      );
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
      await expect(client.enableAgent('missing')).rejects.toThrow(
        'Gateway enableAgent failed: 404',
      );
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
        routing: [
          { condition: { type: 'default' }, agentId: 'agent-123', allowList: [], denyList: [] },
        ],
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

      expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/channels/my%20channel`, expect.anything());
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
      await expect(client.updateChannel('missing', {})).rejects.toThrow(
        'Gateway updateChannel failed: 404',
      );
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
      await expect(client.removeChannel('missing')).rejects.toThrow(
        'Gateway removeChannel failed: 404',
      );
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
      await expect(client.setCredential('', 'val')).rejects.toThrow(
        'Gateway setCredential failed: 400 invalid key',
      );
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
      await expect(client.removeCredential('missing')).rejects.toThrow(
        'Gateway removeCredential failed: 404',
      );
    });
  });

  describe('mobile v1 conversation contract', () => {
    it('decodes capabilities and stable identity from the frozen fixtures', async () => {
      const health = await fixture<GatewayHealthResponse>('health-capabilities.json');
      const identity = await fixture<GatewayIdentity>('identity.json');
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(health), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(identity), { status: 200 }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.health()).resolves.toEqual(health);
      await expect(client.getIdentity()).resolves.toEqual(identity);
      expect(health.capabilities).toContain('conversation-sync-v1');
      expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE_URL}/health`);
      expect(fetchSpy.mock.calls[1][0]).toBe(`${BASE_URL}/identity`);
      expect(fetchSpy.mock.calls[1][1]).toEqual(
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      );
    });

    it('preserves the public-key-only relay identity compatibility method', async () => {
      const identity = await fixture<GatewayIdentity>('identity.json');
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(identity), { status: 200 }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.getRelayIdentity()).resolves.toEqual({ publicKey: identity.publicKey });
    });

    it('lists conversations and messages with frozen page shapes', async () => {
      const conversations = await fixture<ConversationPage>('conversations-page.json');
      const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(conversations), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(messages), { status: 200 }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN, {
        'x-dash-relay-credential': 'relay-cred',
      });
      await expect(client.listConversations({ agentId: 'agent-1', limit: 50 })).resolves.toEqual(
        conversations,
      );
      await expect(
        client.getConversationMessages('conv-1', { limit: 100, before: 'cursor-1' }),
      ).resolves.toEqual(messages);
      expect(String(fetchSpy.mock.calls[0][0])).toContain(
        '/conversations?agentId=agent-1&limit=50',
      );
      expect(String(fetchSpy.mock.calls[1][0])).toContain(
        '/conversations/conv-1/messages?limit=100&before=cursor-1',
      );
      expect(fetchSpy.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-dash-relay-credential': 'relay-cred' }),
        }),
      );
    });

    it('creates and gets conversations with canonical summaries', async () => {
      const summary = await fixture<ConversationSummary>('conversation-summary.json');
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 201 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(
        client.createConversation('agent-01', 'request-01', {
          title: 'Mobile launch check',
          owningIssueId: 'issue-01',
          projectId: 'project-01',
        }),
      ).resolves.toEqual(summary);
      await expect(client.getConversation('conv/1')).resolves.toEqual(summary);
      expect(fetchSpy.mock.calls[0]).toEqual([
        `${BASE_URL}/conversations`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining(AUTH_HEADER),
          body: JSON.stringify({
            agentId: 'agent-01',
            requestId: 'request-01',
            title: 'Mobile launch check',
            owningIssueId: 'issue-01',
            projectId: 'project-01',
          }),
        }),
      ]);
      expect(fetchSpy.mock.calls[1][0]).toBe(`${BASE_URL}/conversations/conv%2F1`);
    });

    it('patches and deletes conversations with quoted revision preconditions', async () => {
      const summary = await fixture<ConversationSummary>('conversation-summary.json');
      const tombstone: ConversationSummary = {
        ...summary,
        revision: 4,
        status: 'deleted',
        deletedAt: '2026-07-12T00:01:00.000Z',
      };
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(tombstone), { status: 200 }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(
        client.patchConversation('conv/1', 2, { title: 'Manual title' }),
      ).resolves.toEqual(summary);
      await expect(client.deleteConversation('conv/1', 3)).resolves.toEqual(tombstone);
      expect(fetchSpy.mock.calls[0]).toEqual([
        `${BASE_URL}/conversations/conv%2F1`,
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({ 'If-Match': '"2"' }),
          body: JSON.stringify({ title: 'Manual title' }),
        }),
      ]);
      expect(fetchSpy.mock.calls[1]).toEqual([
        `${BASE_URL}/conversations/conv%2F1`,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({ 'If-Match': '"3"' }),
        }),
      ]);
    });

    it('replays persisted events after the requested sequence', async () => {
      const replay = await fixture<ReplayPage>('replay.json');
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(replay), { status: 200 }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await expect(client.replayConversationEvents('agent/1', 'conv/1', 2)).resolves.toEqual(
        replay,
      );
      expect(fetchSpy.mock.calls[0]).toEqual([
        `${BASE_URL}/agents/agent%2F1/conversations/conv%2F1/events?sinceSeq=2`,
        expect.objectContaining({ headers: expect.objectContaining(AUTH_HEADER) }),
      ]);
    });

    it('omits absent optional conversation query values', async () => {
      const conversations = await fixture<ConversationPage>('conversations-page.json');
      const messages = await fixture<ConversationMessagePage>('conversation-messages-page.json');
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(conversations), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(messages), { status: 200 }));

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      await client.listConversations();
      await client.getConversationMessages('conv-1');
      expect(String(fetchSpy.mock.calls[0][0])).toBe(`${BASE_URL}/conversations`);
      expect(String(fetchSpy.mock.calls[1][0])).toBe(`${BASE_URL}/conversations/conv-1/messages`);
    });

    it('sends If-Match and exposes a frozen revision conflict', async () => {
      const conflict = await fixture<MobileApiError>('errors/revision-conflict.json');
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(conflict), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const error = await client
        .patchConversation('conv-1', 7, { title: 'Manual title' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GatewayHttpError);
      expect((error as GatewayHttpError).apiError).toEqual(conflict);
      expect(fetchSpy.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({ 'If-Match': '"7"' }),
        }),
      );
    });

    it('retains plain and malformed error bodies without inventing structured errors', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response('upstream unavailable', { status: 502 }))
        .mockResolvedValueOnce(
          new Response('{broken', {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        );

      const client = new GatewayManagementClient(BASE_URL, TOKEN);
      const plain = await client.getConversation('conv-1').catch((caught: unknown) => caught);
      const malformed = await client.getConversation('conv-1').catch((caught: unknown) => caught);
      expect(plain).toBeInstanceOf(GatewayHttpError);
      expect((plain as GatewayHttpError).apiError).toBeUndefined();
      expect((plain as Error).message).toBe(
        'Gateway getConversation failed: 502 upstream unavailable',
      );
      expect(malformed).toBeInstanceOf(GatewayHttpError);
      expect((malformed as GatewayHttpError).apiError).toBeUndefined();
    });
  });
});
