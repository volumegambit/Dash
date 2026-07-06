import type { RemoteGatewaySecrets } from '@dash/mc';
import type { GatewayConnectionStatus, GatewayRelayConnectionInput } from '../shared/ipc.js';
import {
  normalizeGatewayRelayInput,
  saveGatewayRelayConnection,
  testGatewayRelayConnection,
} from './gateway-connection.js';

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
    checkRemoteGateway: vi.fn<
      [(typeof healthyStatus)['profile'], RemoteGatewaySecrets],
      Promise<void>
    >(async () => {}),
    setRemoteGatewaySecrets: vi.fn<[RemoteGatewaySecrets], Promise<void>>(async () => {}),
    setGatewayConnection: vi.fn<[(typeof healthyStatus)['profile']], Promise<void>>(async () => {}),
    refreshChatServiceConnection: vi.fn<[], Promise<void>>(async () => {}),
    getGatewayConnectionStatus: vi.fn<[], Promise<GatewayConnectionStatus>>(
      async () => healthyStatus,
    ),
  };
}

describe('gateway connection helpers', () => {
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
