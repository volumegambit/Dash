import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayHttpError, type RemoteGatewaySecrets } from '@dash/mc';
import type { GatewayIdentity, MobileHealth } from '@dash/mobile-contract';
import type { GatewayConnectionStatus, GatewayRelayConnectionInput } from '../shared/ipc.js';
import {
  classifyConversationGatewayFailure,
  normalizeGatewayRelayInput,
  saveGatewayRelayConnection,
  testGatewayRelayConnection,
  verifyConversationGateway,
} from './gateway-connection.js';

async function fixture<T>(name: string): Promise<T> {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../contracts/mobile/v1/fixtures',
  );
  return JSON.parse(await readFile(resolve(root, name), 'utf8')) as T;
}

const verifiedGateway = {
  identity: { gatewayId: 'gateway-01', publicKey: 'dash-test-public-key' },
  apiVersion: 1,
  capabilities: ['conversation-sync-v1', 'chat-resume-v1'] as const,
};

const validInput: GatewayRelayConnectionInput = {
  mode: 'relay',
  name: '  Production  ',
  managementBaseUrl: 'https://gw.example.com/',
  chatBaseUrl: '',
  managementToken: '  management-token  ',
  chatToken: '  chat-token  ',
  relayCredential: '  relay-secret  ',
};

function createDeps() {
  const healthyStatus: GatewayConnectionStatus = {
    profile: {
      mode: 'relay',
      name: 'Production',
      managementBaseUrl: 'https://gw.example.com',
      chatBaseUrl: 'wss://gw.example.com',
    },
    hasRemoteSecrets: true,
    health: 'healthy',
  };

  return {
    now: vi.fn(() => '2026-07-06T12:00:00.000Z'),
    checkRemoteGateway: vi.fn(async () => verifiedGateway),
    setRemoteGatewaySecrets: vi.fn<[RemoteGatewaySecrets], Promise<void>>(async () => {}),
    setGatewayConnection: vi.fn<[(typeof healthyStatus)['profile']], Promise<void>>(async () => {}),
    refreshChatServiceConnection: vi.fn<[], Promise<void>>(async () => {}),
    getGatewayConnectionStatus: vi.fn<[], Promise<GatewayConnectionStatus>>(
      async () => healthyStatus,
    ),
  };
}

describe('gateway connection helpers', () => {
  it('verifies capable health before requiring authenticated identity', async () => {
    const health = await fixture<MobileHealth>('health-capabilities.json');
    const identity = await fixture<GatewayIdentity>('identity.json');
    const client = {
      health: vi.fn().mockResolvedValue(health),
      getIdentity: vi.fn().mockResolvedValue(identity),
    };

    await expect(verifyConversationGateway(client)).resolves.toEqual({
      identity,
      apiVersion: 1,
      capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
    });
    expect(client.health.mock.invocationCallOrder[0]).toBeLessThan(
      client.getIdentity.mock.invocationCallOrder[0],
    );
  });

  it('accepts an old gateway without calling the identity endpoint', async () => {
    const client = {
      health: vi.fn().mockResolvedValue({
        status: 'healthy',
        startedAt: '2026-07-12T00:00:00.000Z',
        agents: 1,
        channels: 1,
      }),
      getIdentity: vi.fn(),
    };

    await expect(verifyConversationGateway(client)).resolves.toEqual({
      identity: null,
      apiVersion: 0,
      capabilities: [],
    });
    expect(client.getIdentity).not.toHaveBeenCalled();
  });

  it('rejects a capable gateway when authenticated identity fails', async () => {
    const health = await fixture<MobileHealth>('health-capabilities.json');
    const client = {
      health: vi.fn().mockResolvedValue(health),
      getIdentity: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
    };

    await expect(verifyConversationGateway(client)).rejects.toThrow('401 Unauthorized');
  });

  it.each([
    [
      'identity authorization',
      new GatewayHttpError(401, 'get identity', '', {
        code: 'unauthorized',
        error: 'Unauthorized',
        retryable: false,
      }),
      { kind: 'repair_required', retryable: false },
    ],
    [
      'identity rate limit',
      new GatewayHttpError(429, 'get identity', '', {
        code: 'rate_limited',
        error: 'Too many requests',
        retryable: true,
        details: { retryAfterMs: 9_000 },
      }),
      { kind: 'rate_limited', retryable: true, retryAfterMs: 9_000 },
    ],
    [
      'capability mismatch',
      new GatewayHttpError(426, 'get identity', '', {
        code: 'capability_required',
        error: 'Upgrade required',
        retryable: false,
      }),
      { kind: 'update_required', retryable: false },
    ],
    ['network outage', new TypeError('fetch failed'), { kind: 'gateway_offline', retryable: true }],
  ])(
    'classifies %s without collapsing it into a generic offline state',
    (_label, error, expected) => {
      expect(classifyConversationGatewayFailure(error)).toMatchObject(expected);
    },
  );

  it('normalizes an existing gateway connection and derives the chat URL', () => {
    const normalized = normalizeGatewayRelayInput(validInput, '2026-07-06T12:00:00.000Z');

    expect(normalized.profile).toEqual({
      mode: 'relay',
      name: 'Production',
      managementBaseUrl: 'https://gw.example.com',
      chatBaseUrl: 'wss://gw.example.com',
      updatedAt: '2026-07-06T12:00:00.000Z',
    });
    expect(normalized.secrets).toEqual({
      managementToken: 'management-token',
      chatToken: 'chat-token',
      relayCredential: 'relay-secret',
    });
  });

  it('requires the URL and both tokens before testing a connection', async () => {
    expect(() =>
      normalizeGatewayRelayInput(
        { ...validInput, managementBaseUrl: '  ' },
        '2026-07-06T12:00:00.000Z',
      ),
    ).toThrow('Management URL is required');
    expect(() =>
      normalizeGatewayRelayInput(
        { ...validInput, managementToken: '  ' },
        '2026-07-06T12:00:00.000Z',
      ),
    ).toThrow('Management token is required');
    expect(() =>
      normalizeGatewayRelayInput({ ...validInput, chatToken: '  ' }, '2026-07-06T12:00:00.000Z'),
    ).toThrow('Chat token is required');
  });

  it('returns a user-facing failure when the gateway health check fails', async () => {
    const deps = createDeps();
    deps.checkRemoteGateway.mockRejectedValueOnce(new Error('401 Unauthorized'));

    const result = await testGatewayRelayConnection(validInput, deps);

    expect(result).toEqual({
      ok: false,
      message: 'Could not reach that gateway. Check the URL and tokens, then try again.',
    });
  });

  it('does not persist an unreachable remote gateway', async () => {
    const deps = createDeps();
    deps.checkRemoteGateway.mockRejectedValueOnce(new Error('network down'));

    await expect(saveGatewayRelayConnection(validInput, deps)).rejects.toThrow(
      'Could not reach that gateway. Check the URL and tokens, then try again.',
    );

    expect(deps.setRemoteGatewaySecrets).not.toHaveBeenCalled();
    expect(deps.setGatewayConnection).not.toHaveBeenCalled();
    expect(deps.refreshChatServiceConnection).not.toHaveBeenCalled();
  });

  it('persists capable verified identity metadata without secrets', async () => {
    const deps = createDeps();

    await saveGatewayRelayConnection(validInput, deps);

    expect(deps.setGatewayConnection).toHaveBeenCalledWith({
      mode: 'relay',
      name: 'Production',
      managementBaseUrl: 'https://gw.example.com',
      chatBaseUrl: 'wss://gw.example.com',
      updatedAt: '2026-07-06T12:00:00.000Z',
      gatewayId: 'gateway-01',
      apiVersion: 1,
      capabilities: ['conversation-sync-v1', 'chat-resume-v1'],
    });
    expect(JSON.stringify(deps.setGatewayConnection.mock.calls[0][0])).not.toMatch(
      /managementToken|chatToken|relayCredential/,
    );
  });

  it('persists explicit old-gateway metadata without an identity', async () => {
    const deps = createDeps();
    deps.checkRemoteGateway.mockResolvedValueOnce({
      identity: null,
      apiVersion: 0,
      capabilities: [],
    });

    await saveGatewayRelayConnection(validInput, deps);

    expect(deps.setGatewayConnection).toHaveBeenCalledWith(
      expect.objectContaining({ apiVersion: 0, capabilities: [] }),
    );
    expect(deps.setGatewayConnection.mock.calls[0][0]).not.toHaveProperty('gatewayId');
  });

  it('persists nothing when capable identity verification fails', async () => {
    const deps = createDeps();
    deps.checkRemoteGateway.mockRejectedValueOnce(new Error('identity unauthorized'));

    await expect(saveGatewayRelayConnection(validInput, deps)).rejects.toThrow(
      'Could not reach that gateway. Check the URL and tokens, then try again.',
    );

    expect(deps.setRemoteGatewaySecrets).not.toHaveBeenCalled();
    expect(deps.setGatewayConnection).not.toHaveBeenCalled();
    expect(deps.refreshChatServiceConnection).not.toHaveBeenCalled();
  });

  it('checks a remote gateway before storing secrets and activating the profile', async () => {
    const deps = createDeps();

    await saveGatewayRelayConnection(validInput, deps);

    expect(deps.checkRemoteGateway).toHaveBeenCalledWith(
      {
        mode: 'relay',
        name: 'Production',
        managementBaseUrl: 'https://gw.example.com',
        chatBaseUrl: 'wss://gw.example.com',
        updatedAt: '2026-07-06T12:00:00.000Z',
      },
      {
        managementToken: 'management-token',
        chatToken: 'chat-token',
        relayCredential: 'relay-secret',
      },
    );
    expect(deps.checkRemoteGateway.mock.invocationCallOrder[0]).toBeLessThan(
      deps.setRemoteGatewaySecrets.mock.invocationCallOrder[0],
    );
    expect(deps.checkRemoteGateway.mock.invocationCallOrder[0]).toBeLessThan(
      deps.setGatewayConnection.mock.invocationCallOrder[0],
    );
  });
});
