import type { ConversationCreateRequest, ConversationPatchRequest } from '@dash/mobile-contract';
import { MobileApiError, MobileRestClient, type TokenSource } from './rest';

const TOKEN = 'test-token-abc';

function tokenSource(token = TOKEN): TokenSource {
  return { getToken: () => Promise.resolve(token) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(response: Response | (() => Response)) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    typeof response === 'function' ? response() : response,
  );
}

function authHeader(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

function relayCredentialHeader(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.['x-dash-relay-credential'];
}

function ifMatchHeader(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.['If-Match'];
}

/** Byte-for-byte what the relay returns when it rejects a revoked credential
 *  before the request reaches the gateway: plain text, no JSON error envelope,
 *  plus the CORS headers that make it readable from a browser at all. */
function relayUnauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'content-type': 'text/plain',
      'access-control-allow-origin': 'https://app.example.com',
      vary: 'Origin',
    },
  });
}

describe('MobileRestClient', () => {
  describe('URL joining under the /mobile/v1 base', () => {
    it('joins health() under a base without a trailing slash', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ status: 'healthy' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.health();
      expect(fetchImpl.mock.calls[0][0]).toBe('https://sub.relay.example/mobile/v1/health');
    });

    it('joins health() under a base with a trailing slash without a double slash', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ status: 'healthy' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1/',
        tokenSource(),
        fetchImpl,
      );
      await client.health();
      expect(fetchImpl.mock.calls[0][0]).toBe('https://sub.relay.example/mobile/v1/health');
    });

    it('preserves the /mobile/v1 prefix for nested paths (no accidental base-path drop)', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ items: [], nextCursor: null, throughSeq: 0 }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.getMessages('conv-1');
      const url = fetchImpl.mock.calls[0][0] as string;
      expect(
        url.startsWith('https://sub.relay.example/mobile/v1/conversations/conv-1/messages'),
      ).toBe(true);
    });

    it('maps listConversations cursor to a ?cursor= query param', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ items: [], nextCursor: null }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.listConversations('opaque-cursor-1');
      const url = new URL(fetchImpl.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/mobile/v1/conversations');
      expect(url.searchParams.get('cursor')).toBe('opaque-cursor-1');
    });

    it('omits the cursor query param when not provided', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ items: [], nextCursor: null }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.listConversations();
      const url = new URL(fetchImpl.mock.calls[0][0] as string);
      expect(url.searchParams.has('cursor')).toBe(false);
    });

    it('joins listAgents() under the /agents path', async () => {
      const fetchImpl = fakeFetch(jsonResponse([]));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.listAgents();
      const url = new URL(fetchImpl.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/mobile/v1/agents');
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    });

    it('encodes the conversationId path segment for getMessages', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ items: [], nextCursor: null, throughSeq: 0 }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.getMessages('conv/with/slash', 'before-cursor');
      const url = new URL(fetchImpl.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/mobile/v1/conversations/conv%2Fwith%2Fslash/messages');
      expect(url.searchParams.get('before')).toBe('before-cursor');
    });
  });

  describe('authorization', () => {
    it('does not send an Authorization header for health()', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ status: 'healthy' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.health();
      expect(authHeader(fetchImpl.mock.calls[0][1])).toBeUndefined();
    });

    it.each([
      ['identity', (c: MobileRestClient) => c.identity()],
      ['listConversations', (c: MobileRestClient) => c.listConversations()],
      ['getMessages', (c: MobileRestClient) => c.getMessages('conv-1')],
      [
        'createConversation',
        (c: MobileRestClient) =>
          c.createConversation({ agentId: 'a', requestId: 'r' } as ConversationCreateRequest),
      ],
      ['createWsTicket', (c: MobileRestClient) => c.createWsTicket()],
      ['listAgents', (c: MobileRestClient) => c.listAgents()],
      ['getConversation', (c: MobileRestClient) => c.getConversation('conv-1')],
      [
        'patchConversation',
        (c: MobileRestClient) => c.patchConversation('conv-1', { title: 'New title' }, 1),
      ],
      ['deleteConversation', (c: MobileRestClient) => c.deleteConversation('conv-1', 1)],
    ])('sends Authorization: Bearer <token> for %s()', async (_name, call) => {
      const fetchImpl = fakeFetch(
        jsonResponse({
          gatewayId: 'g',
          publicKey: 'p',
          items: [],
          nextCursor: null,
          throughSeq: 0,
          id: 'c',
          ticket: 't',
          expiresAt: 'e',
        }),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await call(client);
      expect(authHeader(fetchImpl.mock.calls[0][1])).toBe(`Bearer ${TOKEN}`);
    });
  });

  describe('relay credential', () => {
    it('omits x-dash-relay-credential when none is configured', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ status: 'healthy' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.health();
      expect(relayCredentialHeader(fetchImpl.mock.calls[0][1])).toBeUndefined();
    });

    it('sends x-dash-relay-credential on health() (an unauthenticated request) when configured', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ status: 'healthy' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
        'relay-cred-xyz',
      );
      await client.health();
      expect(relayCredentialHeader(fetchImpl.mock.calls[0][1])).toBe('relay-cred-xyz');
      // health() still sends no Authorization header — relayCredential is a
      // separate, additive header, not a replacement for the bearer scheme.
      expect(authHeader(fetchImpl.mock.calls[0][1])).toBeUndefined();
    });

    it('sends x-dash-relay-credential alongside Authorization on an authenticated request', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ gatewayId: 'g', publicKey: 'p' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
        'relay-cred-xyz',
      );
      await client.identity();
      expect(relayCredentialHeader(fetchImpl.mock.calls[0][1])).toBe('relay-cred-xyz');
      expect(authHeader(fetchImpl.mock.calls[0][1])).toBe(`Bearer ${TOKEN}`);
    });
  });

  describe('error handling', () => {
    it('throws MobileApiError with status and code from the error body on non-2xx', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse(
          { code: 'not_found', error: 'Conversation was not found', retryable: false },
          404,
        ),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.getMessages('missing-conv')).rejects.toMatchObject(
        expect.objectContaining({
          status: 404,
          code: 'not_found',
        }),
      );
      await expect(client.getMessages('missing-conv')).rejects.toBeInstanceOf(MobileApiError);
    });

    it('tolerates a non-JSON error body and still reports the status with an undefined code', async () => {
      const fetchImpl = fakeFetch(new Response('gateway is down', { status: 503 }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.identity()).rejects.toMatchObject({ status: 503, code: undefined });
    });

    it('surfaces a code-less structured error body as an undefined code', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse({ error: 'Structured errors require a code', retryable: false }, 500),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.identity()).rejects.toMatchObject({ status: 500, code: undefined });
    });
  });

  describe('JSON body passthrough', () => {
    it('resolves health() with the typed MobileHealth body', async () => {
      const body = {
        status: 'healthy' as const,
        startedAt: '2026-07-12T00:00:00.000Z',
        pid: 4242,
        agents: 1,
        channels: 1,
        apiVersion: 1 as const,
        capabilities: ['conversation-sync-v1' as const],
      };
      const fetchImpl = fakeFetch(jsonResponse(body));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await expect(client.health()).resolves.toEqual(body);
    });

    it('POSTs a JSON body for createConversation and resolves the typed response', async () => {
      const responseBody = {
        id: 'conv-1',
        agentId: 'a',
        agentName: 'Agent',
        title: 'Title',
        revision: 1,
        status: 'idle' as const,
        activeTurnId: null,
        owningIssueId: null,
        projectId: null,
        lastSeq: 0,
        lastMessagePreview: null,
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
      };
      const fetchImpl = fakeFetch(jsonResponse(responseBody, 201));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      const request: ConversationCreateRequest = { agentId: 'a', requestId: 'r-1' };
      await expect(client.createConversation(request)).resolves.toEqual(responseBody);

      const [, init] = fetchImpl.mock.calls[0];
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual(request);
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('resolves listAgents() with the typed MobileAgent[] body (a bare array, no envelope)', async () => {
      const body = [
        {
          id: 'agent-1',
          name: 'Mobile Helper',
          config: {
            name: 'Mobile Helper',
            model: 'anthropic/claude-sonnet',
            systemPrompt: 'Help.',
          },
          status: 'active' as const,
          registeredAt: '2026-07-12T00:00:00.000Z',
        },
      ];
      const fetchImpl = fakeFetch(jsonResponse(body));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await expect(client.listAgents()).resolves.toEqual(body);
    });

    it('resolves createWsTicket() with the typed WsTicketResponse body', async () => {
      const body = {
        ticket: '0123456789abcdef0123456789abcdef',
        expiresAt: '2026-08-29T12:00:30Z',
      };
      const fetchImpl = fakeFetch(jsonResponse(body));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await expect(client.createWsTicket()).resolves.toEqual(body);
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
    });
  });

  describe('conversation management (rename/delete, audit #8)', () => {
    const conversationBody = {
      id: 'conv-1',
      agentId: 'a',
      agentName: 'Agent',
      title: 'New Conversation',
      revision: 2,
      status: 'idle' as const,
      activeTurnId: null,
      owningIssueId: null,
      projectId: null,
      lastSeq: 0,
      lastMessagePreview: null,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };

    it('GETs /conversations/:id for getConversation() and resolves the typed summary', async () => {
      const fetchImpl = fakeFetch(jsonResponse(conversationBody));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await expect(client.getConversation('conv-1')).resolves.toEqual(conversationBody);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(new URL(url as string).pathname).toBe('/mobile/v1/conversations/conv-1');
      expect(init?.method).toBe('GET');
    });

    it('PATCHes /conversations/:id with the title body and a quoted If-Match revision', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ ...conversationBody, title: 'Renamed' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      const patch: ConversationPatchRequest = { title: 'Renamed' };
      await expect(client.patchConversation('conv-1', patch, 3)).resolves.toEqual({
        ...conversationBody,
        title: 'Renamed',
      });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(new URL(url as string).pathname).toBe('/mobile/v1/conversations/conv-1');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(init?.body as string)).toEqual(patch);
      expect(ifMatchHeader(init)).toBe('"3"');
    });

    it('encodes the conversationId path segment for patchConversation', async () => {
      const fetchImpl = fakeFetch(jsonResponse(conversationBody));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await client.patchConversation('conv/with/slash', { title: 'x' }, 1);
      const url = new URL(fetchImpl.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/mobile/v1/conversations/conv%2Fwith%2Fslash');
    });

    it('DELETEs /conversations/:id with a quoted If-Match revision and no body', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse({ ...conversationBody, status: 'deleted' as const }),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await expect(client.deleteConversation('conv-1', 2)).resolves.toEqual({
        ...conversationBody,
        status: 'deleted',
      });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(new URL(url as string).pathname).toBe('/mobile/v1/conversations/conv-1');
      expect(init?.method).toBe('DELETE');
      expect(init?.body).toBeUndefined();
      expect(ifMatchHeader(init)).toBe('"2"');
    });

    it('throws MobileApiError on a revision conflict (409) from patchConversation', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse({ code: 'revision_conflict', error: 'stale revision', retryable: false }, 409),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );
      await expect(client.patchConversation('conv-1', { title: 'x' }, 1)).rejects.toMatchObject({
        status: 409,
        code: 'revision_conflict',
      });
    });
  });
});

describe('relay-generated errors (no JSON envelope)', () => {
  it("surfaces the relay's plain-text 401 as MobileApiError(401) with an undefined code", async () => {
    // The relay answers a revoked pairing credential itself, so there is no
    // gateway `{ code, error, retryable }` body to parse. The status is the
    // whole signal — and it is only visible to a browser because the relay
    // echoes Access-Control-Allow-Origin on its own error responses.
    const fetchImpl = fakeFetch(relayUnauthorizedResponse);
    const client = new MobileRestClient(
      'https://sub.relay.example/mobile/v1',
      tokenSource(),
      fetchImpl,
    );

    const error = await client.listConversations().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(MobileApiError);
    expect((error as MobileApiError).status).toBe(401);
    expect((error as MobileApiError).code).toBeUndefined();
  });
});
