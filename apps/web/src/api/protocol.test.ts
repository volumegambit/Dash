import type { GatewayIdentity } from '@dash/mobile-contract';
import { CHAT_INPUT_QUEUE_CAPABILITY, type MobileV2HealthResponse } from '@dash/mobile-contract-v2';
import { negotiateMobileProtocol } from './protocol.js';
import { MobileRestClient } from './rest.js';

const V2_HEALTH: MobileV2HealthResponse = {
  status: 'healthy',
  startedAt: '2026-09-06T09:00:00.000Z',
  pid: 4242,
  agents: 2,
  channels: 1,
  apiVersion: 2,
  capabilities: [CHAT_INPUT_QUEUE_CAPABILITY, 'future-mobile-capability'],
};

const V1_HEALTH = {
  status: 'healthy' as const,
  startedAt: '2026-09-06T09:00:00.000Z',
  pid: 4242,
  agents: 2,
  channels: 1,
  apiVersion: 1 as const,
  capabilities: ['conversation-sync-v1' as const],
};

const IDENTITY: GatewayIdentity = { gatewayId: 'gw-1', publicKey: 'public-key' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({ unexpected: true }),
  );
  const createRestClient = vi.fn(
    (version: 1 | 2) =>
      new MobileRestClient(
        `https://relay.example/mobile/v${version}`,
        { getToken: async () => 'chat-token' },
        fetchMock,
        'relay-credential',
      ),
  );
  return { createRestClient, fetchMock, options: { createRestClient } };
}

function withoutHealthKey(key: keyof MobileV2HealthResponse): Record<string, unknown> {
  const health: Record<string, unknown> = { ...V2_HEALTH };
  delete health[key];
  return health;
}

describe('negotiateMobileProtocol', () => {
  it('selects v2 only after exact health and identity validation', async () => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(IDENTITY));

    const negotiated = await negotiateMobileProtocol(options);

    expect(negotiated).toMatchObject({
      version: 2,
      capabilities: [CHAT_INPUT_QUEUE_CAPABILITY, 'future-mobile-capability'],
    });
    expect(createRestClient).toHaveBeenCalledTimes(1);
    expect(createRestClient).toHaveBeenCalledWith(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://relay.example/mobile/v2/health',
      'https://relay.example/mobile/v2/identity',
    ]);
  });

  it.each(['2026-09-06t09:00:00z', '2026-09-06T23:59:60Z', '2026-09-07T00:59:60+01:00'])(
    'accepts an RFC 3339 startedAt timestamp: %s',
    async (startedAt) => {
      const { fetchMock, options } = setup();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ ...V2_HEALTH, startedAt }))
        .mockResolvedValueOnce(jsonResponse(IDENTITY));

      await expect(negotiateMobileProtocol(options)).resolves.toMatchObject({ version: 2 });
    },
  );

  it('rejects a leap second outside the offset-adjusted UTC 23:59 boundary', async () => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...V2_HEALTH, startedAt: '2026-09-06T09:00:60Z' }),
    );

    await expect(negotiateMobileProtocol(options)).rejects.toThrow('Malformed mobile v2 health');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createRestClient).toHaveBeenCalledTimes(1);
  });

  it('falls back when the v2 health endpoint is absent', async () => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse(V1_HEALTH))
      .mockResolvedValueOnce(jsonResponse(IDENTITY));

    await expect(negotiateMobileProtocol(options)).resolves.toMatchObject({
      version: 1,
      capabilities: [],
    });
    expect(createRestClient.mock.calls.map(([version]) => version)).toEqual([2, 1]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://relay.example/mobile/v2/health',
      'https://relay.example/mobile/v1/health',
      'https://relay.example/mobile/v1/identity',
    ]);
  });

  it('falls back on a fully validated capability_required v2 health response', async () => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 'capability_required',
            error: 'Mobile v2 is not supported',
            retryable: false,
            details: { required: CHAT_INPUT_QUEUE_CAPABILITY },
          },
          426,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(V1_HEALTH))
      .mockResolvedValueOnce(jsonResponse(IDENTITY));

    await expect(negotiateMobileProtocol(options)).resolves.toMatchObject({ version: 1 });
    expect(createRestClient.mock.calls.map(([version]) => version)).toEqual([2, 1]);
  });

  it('does not downgrade an identity failure after successful v2 health', async () => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse({}, 404));

    await expect(negotiateMobileProtocol(options)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createRestClient).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { gatewayId: 'gw-1' },
    { publicKey: 'pk' },
    { gatewayId: '', publicKey: 'pk' },
    { gatewayId: 'gw-1', publicKey: '' },
    { gatewayId: 'gw-1', publicKey: 'pk', extra: true },
    [],
  ])('rejects malformed HTTP 200 v2 identity without downgrading: %#', async (body) => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(body));

    await expect(negotiateMobileProtocol(options)).rejects.toThrow('Malformed gateway identity');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createRestClient).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-JSON HTTP 200 v2 identity without downgrading', async () => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(V2_HEALTH))
      .mockResolvedValueOnce(new Response('not JSON', { status: 200 }));

    await expect(negotiateMobileProtocol(options)).rejects.toThrow('Malformed gateway identity');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createRestClient).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, { code: 'unauthorized', error: 'No token', retryable: false }],
    [500, { code: 'gateway_offline', error: 'Gateway offline', retryable: true }],
  ])('does not downgrade HTTP %s', async (status, body) => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(body, status));

    await expect(negotiateMobileProtocol(options)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createRestClient).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 'capability_required' },
    { code: 'capability_required', error: 'unsupported' },
    { code: 'capability_required', error: 'unsupported', retryable: 'no' },
    {
      code: 'capability_required',
      error: 'unsupported',
      retryable: false,
      details: null,
    },
    {
      code: 'capability_required',
      error: 'unsupported',
      retryable: false,
      extra: true,
    },
  ])('does not downgrade an incomplete 426 error body: %#', async (body) => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(body, 426));

    await expect(negotiateMobileProtocol(options)).rejects.toMatchObject({
      status: 426,
      code: undefined,
      apiError: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createRestClient).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade capability_required from any request after v2 health', async () => {
    const { createRestClient, fetchMock, options } = setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(V2_HEALTH)).mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'capability_required',
          error: 'Identity is unavailable',
          retryable: false,
        },
        426,
      ),
    );

    await expect(negotiateMobileProtocol(options)).rejects.toMatchObject({
      status: 426,
      code: 'capability_required',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createRestClient).toHaveBeenCalledTimes(1);
  });

  const malformedHealthCases: Array<[string, unknown]> = [
    ...(
      ['status', 'startedAt', 'pid', 'agents', 'channels', 'apiVersion', 'capabilities'] as const
    ).map((key) => [`missing ${key}`, withoutHealthKey(key)] as [string, unknown]),
    ['wrong status', { ...V2_HEALTH, status: 'starting' }],
    ['date without a time', { ...V2_HEALTH, startedAt: '2026-09-06' }],
    ['impossible RFC 3339 date', { ...V2_HEALTH, startedAt: '2026-02-30T09:00:00Z' }],
    ['space instead of T separator', { ...V2_HEALTH, startedAt: '2026-09-06 09:00:00Z' }],
    ['zero pid', { ...V2_HEALTH, pid: 0 }],
    ['unsafe pid', { ...V2_HEALTH, pid: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative agents', { ...V2_HEALTH, agents: -1 }],
    ['fractional agents', { ...V2_HEALTH, agents: 1.5 }],
    ['negative channels', { ...V2_HEALTH, channels: -1 }],
    ['unsafe channels', { ...V2_HEALTH, channels: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong api version', { ...V2_HEALTH, apiVersion: 1 }],
    ['non-array capabilities', { ...V2_HEALTH, capabilities: CHAT_INPUT_QUEUE_CAPABILITY }],
    ['missing queue capability', { ...V2_HEALTH, capabilities: ['future-capability'] }],
    [
      'duplicate capabilities',
      { ...V2_HEALTH, capabilities: [CHAT_INPUT_QUEUE_CAPABILITY, CHAT_INPUT_QUEUE_CAPABILITY] },
    ],
    ['empty capability', { ...V2_HEALTH, capabilities: [CHAT_INPUT_QUEUE_CAPABILITY, ''] }],
    ['non-string capability', { ...V2_HEALTH, capabilities: [CHAT_INPUT_QUEUE_CAPABILITY, 7] }],
    ['extra top-level key', { ...V2_HEALTH, extra: true }],
  ];

  it.each(malformedHealthCases)(
    'rejects malformed v2 health without downgrading: %s',
    async (_label, body) => {
      const { createRestClient, fetchMock, options } = setup();
      fetchMock.mockResolvedValueOnce(jsonResponse(body));

      await expect(negotiateMobileProtocol(options)).rejects.toThrow('Malformed mobile v2 health');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(createRestClient).toHaveBeenCalledTimes(1);
    },
  );
});
