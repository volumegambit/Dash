import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';
import { ChatSocket } from '../api/chat-socket.js';
import { MobileRestClient } from '../api/rest.js';
import type { GatewayInfo } from '../auth/control-plane.js';
import type { StoredCredential } from '../auth/credential-store.js';
import type { WebAppState, WebAppStoreDeps } from '../state/store.js';
import { Shell } from './Shell.js';

vi.mock('../api/rest.js', () => ({
  MobileRestClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../api/chat-socket.js', () => ({
  ChatSocket: vi.fn().mockImplementation(() => ({})),
}));

/** A real (unmocked) zustand store shaped like `WebAppState`, with inert
 * no-op actions — good enough for `ConversationList`/`ChatView` (Task 13),
 * which this Shell now actually mounts, to render without crashing. Shell's
 * own tests care about *wiring* (REST client, socketFactory args), not
 * chat-surface behavior — that's covered by ChatView/ConversationList's own
 * test files. */
function fakeWebAppState() {
  return create<WebAppState>(() => ({
    conversations: [],
    transcripts: {},
    connection: 'connected',
    loadConversations: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
  }));
}

// `createWebAppStore` never calls `deps.socketFactory` itself — it only
// invokes it once a consumer (ChatView) calls `openConversation()`. To prove
// the ChatSocket wiring (relay credential, chat token) is correct
// independent of ChatView's own behavior, capture `deps` here and invoke
// `socketFactory` directly.
const capturedStoreDeps: WebAppStoreDeps[] = [];
vi.mock('../state/store.js', () => ({
  createWebAppStore: vi.fn().mockImplementation((deps: WebAppStoreDeps) => {
    capturedStoreDeps.push(deps);
    return fakeWebAppState();
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
  pairingId: 'p-1',
};

function baseControlPlaneClient() {
  return {
    listGateways: vi.fn(async () => [GATEWAY]),
    createWebPairing: vi.fn(),
    listPairings: vi.fn(async () => []),
    deletePairing: vi.fn(),
  };
}

describe('Shell', () => {
  afterEach(() => {
    vi.mocked(MobileRestClient).mockClear();
    vi.mocked(ChatSocket).mockClear();
    capturedStoreDeps.length = 0;
  });

  it('skips straight to the chat view when a gateway credential is already stored', async () => {
    const controlPlaneClient = baseControlPlaneClient();
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(),
      delete: vi.fn(),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());
  });

  it('builds the mobile REST client and chat socket from the stored chat token and relay credential, never the Clerk token', async () => {
    const controlPlaneClient = baseControlPlaneClient();
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(),
      delete: vi.fn(),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());

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
    const controlPlaneClient = baseControlPlaneClient();
    const credentialStore = {
      get: vi.fn(async () => null),
      set: vi.fn(),
      delete: vi.fn(),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByText('acme')).toBeTruthy());
    expect(screen.queryByTestId('chat-workspace')).toBeNull();
  });

  it('shows the empty-state pointer copy when the account has no gateways at all', async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => []),
      createWebPairing: vi.fn(),
      listPairings: vi.fn(),
      deletePairing: vi.fn(),
    };
    const credentialStore = {
      get: vi.fn(async () => null),
      set: vi.fn(),
      delete: vi.fn(),
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
      listPairings: vi.fn(async () => []),
      deletePairing: vi.fn(),
    };
    const credentialStore = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(),
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

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());
    expect(credentialStore.set).toHaveBeenCalledWith('gw-1', {
      relayCredential: 'fresh-relay-cred',
      chatToken: 'fresh-chat-token',
      pairingId: 'p-1',
    });
  });

  it("revoking this browser's own pairing from the Devices screen routes back to the gateway picker", async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => [GATEWAY]),
      createWebPairing: vi.fn(),
      listPairings: vi.fn(async () => [
        { id: 'p-1', deviceLabel: 'Web · Chrome', clientKind: 'web' },
      ]),
      deletePairing: vi.fn(async () => undefined),
    };
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(),
      delete: vi.fn(async () => undefined),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());
    fireEvent.click(screen.getByText('Devices'));

    await waitFor(() => expect(screen.getByText('Web · Chrome')).toBeTruthy());
    fireEvent.click(screen.getByText('Revoke'));

    await waitFor(() => expect(credentialStore.delete).toHaveBeenCalledWith('gw-1'));
    expect(controlPlaneClient.deletePairing).toHaveBeenCalledWith('gw-1', 'p-1');
    await waitFor(() => expect(screen.getByText('acme')).toBeTruthy());
    expect(screen.queryByTestId('chat-workspace')).toBeNull();
  });
});
