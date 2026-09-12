import type {
  ConversationCreateRequest,
  ConversationPatchRequest,
  MobileApiError as MobileApiErrorBody,
  MobileApiErrorCode,
} from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessagePage,
  MobileV2HealthResponse,
} from '@dash/mobile-contract-v2';
import { MobileApiError, MobileRestClient, type TokenSource } from './rest';

const TOKEN = 'test-token-abc';

const V2_HEALTH: MobileV2HealthResponse = {
  status: 'healthy',
  startedAt: '2026-09-06T09:00:00.000Z',
  pid: 4242,
  agents: 1,
  channels: 2,
  apiVersion: 2,
  capabilities: ['chat-input-queue-v1'],
};

const V2_BOOTSTRAP: MobileV2ConversationBootstrap = {
  conversation: {
    id: 'conversation/1',
    agentId: 'agent-1',
    agentName: 'Helper',
    kind: 'user',
    title: 'Queued work',
    revision: 4,
    status: 'running',
    activeTurnId: 'turn-01',
    owningIssueId: null,
    projectId: null,
    lastSeq: 7,
    lastMessagePreview: 'Working',
    createdAt: '2026-09-06T09:00:00.000Z',
    updatedAt: '2026-09-06T09:05:00.000Z',
    queuePaused: false,
    queueRevision: 3,
    pendingFollowUpCount: 1,
    v2LastSeq: 12,
  },
  messages: [],
  nextCursor: 'older/+cursor==',
  pendingInputs: [
    {
      inputId: '00000000-0000-4000-8000-000000000022',
      kind: 'follow_up',
      text: 'Then summarize it.',
      state: 'queued',
      revision: 1,
      enqueueOrder: 2,
      createdAt: '2026-09-06T09:03:00.000Z',
      updatedAt: '2026-09-06T09:04:00.000Z',
    },
  ],
  queuePaused: false,
  queueRevision: 3,
  v2ThroughSeq: 12,
};

const V2_MESSAGE_PAGE: MobileV2ConversationMessagePage = {
  items: [
    {
      id: '00000000-0000-4000-8000-000000000111',
      conversationId: 'conversation/1',
      turnId: '00000000-0000-4000-8000-000000000121',
      ordinal: 2,
      role: 'user',
      status: 'accepted',
      content: { type: 'user', text: 'Steer here.' },
      createdAt: '2026-09-06T09:02:00.000Z',
      updatedAt: '2026-09-06T09:02:00.000Z',
      runId: 'turn-01',
      segmentIndex: 1,
      deliveryKind: 'steer',
      deliveryStatus: 'pending',
    },
  ],
  nextCursor: null,
  throughSeq: 12,
};

const MOBILE_API_ERROR_CODES: readonly MobileApiErrorCode[] = [
  'unauthorized',
  'not_found',
  'validation_failed',
  'revision_conflict',
  'conversation_busy',
  'rate_limited',
  'gateway_offline',
  'capability_required',
];

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

  describe('mobile v2 reads', () => {
    it('requests healthV2() without bearer auth and preserves the relay header', async () => {
      const fetchImpl = fakeFetch(jsonResponse(V2_HEALTH));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v2',
        tokenSource(),
        fetchImpl,
        'relay-cred-xyz',
      );

      await expect(client.healthV2()).resolves.toEqual(V2_HEALTH);

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://sub.relay.example/mobile/v2/health');
      expect(init?.method).toBe('GET');
      expect(authHeader(init)).toBeUndefined();
      expect(relayCredentialHeader(init)).toBe('relay-cred-xyz');
    });

    it('requests an encoded atomic bootstrap with bearer and relay headers', async () => {
      const fetchImpl = fakeFetch(jsonResponse(V2_BOOTSTRAP));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v2',
        tokenSource(),
        fetchImpl,
        'relay-cred-xyz',
      );

      await expect(client.bootstrap('conversation/1')).resolves.toEqual(V2_BOOTSTRAP);

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(
        'https://sub.relay.example/mobile/v2/conversations/conversation%2F1/bootstrap',
      );
      expect(init?.method).toBe('GET');
      expect(authHeader(init)).toBe(`Bearer ${TOKEN}`);
      expect(relayCredentialHeader(init)).toBe('relay-cred-xyz');
    });

    it('requests an encoded v2 message cursor and preserves delivery metadata', async () => {
      const fetchImpl = fakeFetch(jsonResponse(V2_MESSAGE_PAGE));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v2',
        tokenSource(),
        fetchImpl,
        'relay-cred-xyz',
      );

      const page = await client.getMessagesV2('conversation/1', 'opaque/+cursor==', 100);
      expect(page).toEqual(V2_MESSAGE_PAGE);

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(
        'https://sub.relay.example/mobile/v2/conversations/conversation%2F1/messages?limit=100&before=opaque%2F%2Bcursor%3D%3D',
      );
      expect(init?.method).toBe('GET');
      expect(authHeader(init)).toBe(`Bearer ${TOKEN}`);
      expect(relayCredentialHeader(init)).toBe('relay-cred-xyz');
      expect(page.items[0]?.deliveryKind).toBe('steer');
      expect(page.items[0]?.segmentIndex).toBe(1);
      expect(page.items[0]?.deliveryStatus).toBe('pending');
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
      ['bootstrap', (c: MobileRestClient) => c.bootstrap('conv-1')],
      ['getMessagesV2', (c: MobileRestClient) => c.getMessagesV2('conv-1')],
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
    ])('sends Authorization: Bearer <token> for %s()', async (name, call) => {
      const fetchImpl = fakeFetch(
        jsonResponse(
          name === 'identity'
            ? { gatewayId: 'g', publicKey: 'p' }
            : {
                items: [],
                nextCursor: null,
                throughSeq: 0,
                id: 'c',
                ticket: 't',
                expiresAt: 'e',
              },
        ),
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
      const apiError: MobileApiErrorBody = {
        code: 'not_found',
        error: 'Conversation was not found',
        retryable: false,
      };
      const fetchImpl = fakeFetch(jsonResponse(apiError, 404));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.getMessages('missing-conv')).rejects.toMatchObject(
        expect.objectContaining({
          status: 404,
          code: 'not_found',
          apiError,
        }),
      );
      await expect(client.getMessages('missing-conv')).rejects.toBeInstanceOf(MobileApiError);
    });

    it.each(MOBILE_API_ERROR_CODES)(
      'preserves the complete closed %s MobileApiError envelope',
      async (code) => {
        const apiError: MobileApiErrorBody = {
          code,
          error: `Structured ${code} failure`,
          retryable: code === 'rate_limited',
          details: { opaqueFutureField: { nested: true } },
        };
        const fetchImpl = fakeFetch(jsonResponse(apiError, 409));
        const client = new MobileRestClient(
          'https://sub.relay.example/mobile/v2',
          tokenSource(),
          fetchImpl,
        );

        const error = await client.identity().catch((value: unknown) => value);

        expect(error).toBeInstanceOf(MobileApiError);
        expect(error).toMatchObject({ status: 409, code, apiError });
      },
    );

    it.each([
      ['bare code', { code: 'capability_required' }],
      ['missing code', { error: 'Missing code', retryable: false }],
      ['unknown code', { code: 'future_error', error: 'Unknown', retryable: false }],
      ['blank error', { code: 'not_found', error: ' \t\r\n', retryable: false }],
      ['wrong retryable', { code: 'not_found', error: 'Bad flag', retryable: 'false' }],
      [
        'null details',
        { code: 'not_found', error: 'Bad details', retryable: false, details: null },
      ],
      ['array details', { code: 'not_found', error: 'Bad details', retryable: false, details: [] }],
      [
        'extra top-level key',
        { code: 'not_found', error: 'Too wide', retryable: false, extra: true },
      ],
      ['array body', ['not_found', 'failure', false]],
      ['primitive body', 'not_found'],
    ])('does not type an invalid MobileApiError body: %s', async (_label, body) => {
      const fetchImpl = fakeFetch(jsonResponse(body, 426));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v2',
        tokenSource(),
        fetchImpl,
      );

      const error = await client.identity().catch((value: unknown) => value);

      expect(error).toBeInstanceOf(MobileApiError);
      expect(error).toMatchObject({ status: 426, code: undefined, apiError: undefined });
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

    it('resolves identity() only for the exact two-field nonempty shape', async () => {
      const identity = { gatewayId: 'gateway-1', publicKey: 'public-key-1' };
      const fetchImpl = fakeFetch(jsonResponse(identity));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v2',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.identity()).resolves.toEqual(identity);
    });

    it.each([
      {},
      { gatewayId: 'gateway-1' },
      { publicKey: 'public-key-1' },
      { gatewayId: '', publicKey: 'public-key-1' },
      { gatewayId: 'gateway-1', publicKey: '' },
      { gatewayId: 'gateway-1', publicKey: 'public-key-1', extra: true },
      [],
      null,
    ])('rejects malformed HTTP 200 identity: %#', async (body) => {
      const fetchImpl = fakeFetch(jsonResponse(body));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v2',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.identity()).rejects.toThrow('Malformed gateway identity');
    });

    it('normalizes a non-JSON HTTP 200 identity to a malformed-identity error', async () => {
      const fetchImpl = fakeFetch(new Response('not JSON', { status: 200 }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v2',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.identity()).rejects.toThrow('Malformed gateway identity');
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

  describe('listSubagents', () => {
    it("GETs the conversation's children with the id encoded", async () => {
      const fetchImpl = fakeFetch(jsonResponse({ subagents: [{ id: 'child-1' }] }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      const result = await client.listSubagents('conv/1');

      expect(fetchImpl.mock.calls[0][0]).toBe(
        'https://sub.relay.example/mobile/v1/conversations/conv%2F1/subagents',
      );
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
      expect(authHeader(fetchImpl.mock.calls[0][1])).toBe(`Bearer ${TOKEN}`);
      expect(result).toEqual({ subagents: [{ id: 'child-1' }] });
    });
  });

  describe('stopSubagent', () => {
    it('POSTs to /subagents/:id/stop with no body and the id encoded', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ ok: true, status: 'cancelled' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      const result = await client.stopSubagent('child/1');

      expect(fetchImpl.mock.calls[0][0]).toBe(
        'https://sub.relay.example/mobile/v1/subagents/child%2F1/stop',
      );
      const init = fetchImpl.mock.calls[0][1];
      expect(init?.method).toBe('POST');
      // No body at all: the route takes none, and sending `{}` would make a
      // `Content-Type` header the gateway never asked for.
      expect(init?.body).toBeUndefined();
      expect(result).toEqual({ ok: true, status: 'cancelled' });
    });

    /** The gateway answers a stop against an already-finished child with a
     * 409 naming the status that beat it — the caller has to be able to see
     * which one, so it can refresh rather than surface a scary error. */
    it('surfaces the 409 the gateway sends when the child already finished', async () => {
      const fetchImpl = fakeFetch(
        jsonResponse(
          {
            code: 'validation_failed',
            error: 'Sub-agent child-1 is already done',
            retryable: false,
          },
          409,
        ),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.stopSubagent('child-1')).rejects.toMatchObject({
        status: 409,
        code: 'validation_failed',
        detail: 'Sub-agent child-1 is already done',
      });
    });
  });
});

describe('relay-generated errors (no JSON envelope)', () => {
  // Task D2 fix items 2/6: a follow-up typed into a child goes through the
  // gateway's ONE narrowing path (`coordinator.sendToChild`), which is what
  // enforces the one-shot refusal, the steer cap and the grant rebuild. A WS
  // `message` frame reaches none of them.
  describe('resumeSubagent', () => {
    it('POSTs the message to /subagents/:id/resume with the id encoded', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ ok: true, status: 'running', mode: 'queued' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      const result = await client.resumeSubagent('child/1', 'also check the relay');

      expect(fetchImpl.mock.calls[0][0]).toBe(
        'https://sub.relay.example/mobile/v1/subagents/child%2F1/resume',
      );
      const init = fetchImpl.mock.calls[0][1];
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({ message: 'also check the relay' });
      expect(result).toEqual({ ok: true, status: 'running', mode: 'queued' });
    });

    it('carries the client requestId in the body when one is supplied', async () => {
      const fetchImpl = fakeFetch(jsonResponse({ ok: true, status: 'running', mode: 'queued' }));
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await client.resumeSubagent('child-1', 'also check the relay', 'req-7');

      expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
        message: 'also check the relay',
        requestId: 'req-7',
      });
    });

    /**
     * Fix round 4, ruling 5. Nothing in this client sets a deadline, so a POST
     * that hangs (a wedged relay, a half-open socket) never settles — and the
     * composer that awaits it is disarmed in the STORE, so `sending: true`
     * outlives a remount, a collapse and a re-expansion. Only this call is
     * bounded: the whole-client gap is pre-existing and every other call is
     * either idempotent or re-fired by a later read.
     */
    it('bounds the resume POST with an abort signal so a hung request cannot wedge the composer', async () => {
      // Fresh `Response` per call — two requests are made below and a body can
      // only be read once.
      const fetchImpl = fakeFetch(() =>
        jsonResponse({ ok: true, status: 'running', mode: 'queued' }),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await client.resumeSubagent('child-1', 'also check the relay');
      const signal = fetchImpl.mock.calls[0][1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      // ...and only this call. A GET that outlives its deadline just means a
      // slower page; aborting reads would be a behaviour change of its own.
      await client.getMessages('child-1');
      expect(fetchImpl.mock.calls[1][1]?.signal).toBeUndefined();
    });

    it("keeps the gateway's actionable refusal text on the error", async () => {
      const fetchImpl = fakeFetch(
        jsonResponse(
          {
            code: 'validation_failed',
            error: 'Sub-agent child-1 is one-shot and cannot be resumed',
            retryable: false,
          },
          409,
        ),
      );
      const client = new MobileRestClient(
        'https://sub.relay.example/mobile/v1',
        tokenSource(),
        fetchImpl,
      );

      await expect(client.resumeSubagent('child-1', 'more please')).rejects.toMatchObject({
        status: 409,
        code: 'validation_failed',
        detail: 'Sub-agent child-1 is one-shot and cannot be resumed',
      });
    });
  });

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
