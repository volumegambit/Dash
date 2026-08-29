import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatSocket } from '../api/chat-socket.js';
import { MobileRestClient } from '../api/rest.js';
import type { GatewayInfo } from '../auth/control-plane.js';
import type { StoredCredential } from '../auth/credential-store.js';
import type { WebAppStoreDeps } from '../state/store.js';
import { Shell } from './Shell.js';

vi.mock('../api/rest.js', () => ({
  MobileRestClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../api/chat-socket.js', () => ({
  ChatSocket: vi.fn().mockImplementation(() => ({})),
}));

// `createWebAppStore` never calls `deps.socketFactory` itself — it only
// invokes it once a consumer (Task 13's ChatView) calls `openConversation()`.
// This task's Shell only creates the store, so to prove the ChatSocket
// wiring (relay credential, chat token) is correct without waiting for
// Task 13, capture `deps` here and invoke `socketFactory` directly.
const capturedStoreDeps: WebAppStoreDeps[] = [];
vi.mock('../state/store.js', () => ({
  createWebAppStore: vi.fn().mockImplementation((deps: WebAppStoreDeps) => {
    capturedStoreDeps.push(deps);
    return () => ({});
  }),
}));

const GATEWAY: GatewayInfo = {
  gatewayId: 'gw-1',
  subdomain: 'acme',
  status: 'active',
  createdAt: 1,
};

const STORED: StoredCredential = {
  relayCredential: 'relay-cred-abc',
  chatToken: 'chat-token-abc',
};

describe('Shell', () => {
  afterEach(() => {
    vi.mocked(MobileRestClient).mockClear();
    vi.mocked(ChatSocket).mockClear();
    capturedStoreDeps.length = 0;
  });

  it('skips straight to the chat view when a gateway credential is already stored', async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => [GATEWAY]),
      createWebPairing: vi.fn(),
    };
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('chat-view-placeholder')).toBeTruthy());
  });

  it('builds the mobile REST client and chat socket from the stored chat token and relay credential, never the Clerk token', async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => [GATEWAY]),
      createWebPairing: vi.fn(),
    };
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('chat-view-placeholder')).toBeTruthy());

    expect(MobileRestClient).toHaveBeenCalledTimes(1);
    const [baseUrl, tokenSource, , relayCredential] = vi.mocked(MobileRestClient).mock.calls[0];
    expect(baseUrl).toBe('https://acme.relay.example.com/mobile/v1');
    await expect((tokenSource as { getToken(): Promise<string> }).getToken()).resolves.toBe(
      'chat-token-abc',
    );
    expect(relayCredential).toBe('relay-cred-abc');

    expect(capturedStoreDeps).toHaveLength(1);
    capturedStoreDeps[0].socketFactory(
      () => {},
      () => {},
    );
    expect(ChatSocket).toHaveBeenCalledTimes(1);
    const chatSocketCall = vi.mocked(ChatSocket).mock.calls[0];
    expect(chatSocketCall[0]).toBe('wss://acme.relay.example.com/ws/chat');
    expect(chatSocketCall[5]).toBe('relay-cred-abc');
  });

  it('shows the gateway picker when no gateway has a stored credential', async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => [GATEWAY]),
      createWebPairing: vi.fn(),
    };
    const credentialStore = {
      get: vi.fn(async () => null),
      set: vi.fn(),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByText('acme')).toBeTruthy());
    expect(screen.queryByTestId('chat-view-placeholder')).toBeNull();
  });

  it('shows the empty-state pointer copy when the account has no gateways at all', async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => []),
      createWebPairing: vi.fn(),
    };
    const credentialStore = {
      get: vi.fn(async () => null),
      set: vi.fn(),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          'No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine.',
        ),
      ).toBeTruthy(),
    );
  });

  it('transitions to chat once GatewayPicker pairs a gateway (onReady wiring end-to-end)', async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => [GATEWAY]),
      createWebPairing: vi.fn(async () => ({
        credential: 'fresh-relay-cred',
        pairingId: 'p-1',
        chatToken: 'fresh-chat-token',
      })),
    };
    const credentialStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByText('acme')).toBeTruthy());
    fireEvent.click(screen.getByText('acme'));

    await waitFor(() => expect(screen.getByTestId('chat-view-placeholder')).toBeTruthy());
    expect(credentialStore.set).toHaveBeenCalledWith('gw-1', {
      relayCredential: 'fresh-relay-cred',
      chatToken: 'fresh-chat-token',
    });
  });
});
