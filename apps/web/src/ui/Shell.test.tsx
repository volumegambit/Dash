import type { ConversationMessage, ConversationSummary } from '@dash/mobile-contract';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';
import { ChatSocket } from '../api/chat-socket.js';
import { type NegotiatedMobileProtocol, negotiateMobileProtocol } from '../api/protocol.js';
import { MobileRestClient } from '../api/rest.js';
import type { GatewayInfo } from '../auth/control-plane.js';
import type { StoredCredential } from '../auth/credential-store.js';
import type { WebAppState, WebAppStoreDeps } from '../state/store.js';
import {
  DELETE_ACTION_LABEL,
  DELETE_CONFIRM_COPY,
  NEW_CONVERSATION_LABEL,
  RENAME_ACTION_LABEL,
  SEARCH_INPUT_LABEL,
} from './ConversationList.js';
import { SESSION_REVOKED_COPY, Shell } from './Shell.js';

vi.mock('../api/rest.js', () => ({
  MobileRestClient: vi.fn().mockImplementation((baseUrl: string) => ({ baseUrl })),
}));

vi.mock('../api/protocol.js', () => ({
  negotiateMobileProtocol: vi.fn(),
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
    v2Transcripts: {},
    protocol: { version: 1, capabilities: [] },
    connection: 'connected',
    listAgents: vi.fn(async () => []),
    startConversation: vi.fn(async () => {
      throw new Error('startConversation: not used by Shell tests');
    }),
    loadConversations: vi.fn(async () => undefined),
    openConversation: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    enqueueInput: vi.fn<WebAppState['enqueueInput']>(async () => {
      throw new Error('enqueueInput: not used by Shell tests');
    }),
    editFollowUp: vi.fn<WebAppState['editFollowUp']>(async () => {
      throw new Error('editFollowUp: not used by Shell tests');
    }),
    removeFollowUp: vi.fn<WebAppState['removeFollowUp']>(async () => undefined),
    resumeFollowUps: vi.fn<WebAppState['resumeFollowUps']>(async () => undefined),
    loadOlderMessages: vi.fn<WebAppState['loadOlderMessages']>(async () => undefined),
    resendFromMessage: vi.fn(async () => true),
    renameConversation: vi.fn(async () => undefined),
    deleteConversation: vi.fn(async () => undefined),
    cancelTurn: vi.fn(),
    dispose: vi.fn(),
  }));
}

// `createWebAppStore` never calls `deps.socketFactory` itself — it only
// invokes it once a consumer (ChatView) calls `openConversation()`. To prove
// the ChatSocket wiring (relay credential, chat token) is correct
// independent of ChatView's own behavior, capture `deps` here and invoke
// `socketFactory` directly.
const capturedStoreDeps: WebAppStoreDeps[] = [];
// Also capture each created store's bound `dispose` mock, so tests can
// assert Shell tears down the store it's abandoning (self-revocation,
// gateway switch, unmount) rather than leaking a live socket/reconnect timer.
const createdStores: ReturnType<typeof fakeWebAppState>[] = [];
vi.mock('../state/store.js', () => ({
  createWebAppStore: vi.fn().mockImplementation((deps: WebAppStoreDeps) => {
    capturedStoreDeps.push(deps);
    const store = fakeWebAppState();
    createdStores.push(store);
    return store;
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

const GATEWAY_B: GatewayInfo = {
  gatewayId: 'gw-2',
  subdomain: 'beta',
  status: 'active',
  createdAt: 2,
};

const STORED_B: StoredCredential = {
  relayCredential: 'relay-cred-beta',
  chatToken: 'chat-token-beta',
  pairingId: 'p-2',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function baseControlPlaneClient() {
  return {
    listGateways: vi.fn(async () => [GATEWAY]),
    createWebPairing: vi.fn(),
    claimCredential: vi.fn(),
    getPairingStatus: vi.fn(),
    listPairings: vi.fn(async () => []),
    deletePairing: vi.fn(),
  };
}

function conversationSummary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'conv-1',
    agentId: 'agent-1',
    agentName: 'Helper',
    title: 'Chat about the roadmap',
    revision: 1,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function conversationMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    ordinal: 1,
    role: 'user',
    status: 'completed',
    content: { type: 'user', text: 'hi there' },
    createdAt: '2026-08-01T00:00:01.000Z',
    updatedAt: '2026-08-01T00:00:01.000Z',
    ...overrides,
  };
}

/** Renders `Shell` straight through to the `'chat'` view (a stored
 * credential for `GATEWAY`, same as most tests in this file), for the
 * keyboard-shortcut tests below that only care about `ChatWorkspace`'s own
 * behavior once mounted. */
async function renderChatWorkspace(): Promise<void> {
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
}

describe('Shell', () => {
  beforeEach(() => {
    vi.mocked(negotiateMobileProtocol).mockReset();
    vi.mocked(negotiateMobileProtocol).mockImplementation(async ({ createRestClient }) => ({
      version: 1,
      capabilities: [],
      rest: createRestClient(1),
    }));
  });

  afterEach(() => {
    vi.mocked(MobileRestClient).mockClear();
    vi.mocked(ChatSocket).mockClear();
    capturedStoreDeps.length = 0;
    createdStores.length = 0;
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

  it('shows a safe connecting state until asynchronous protocol negotiation creates the store', async () => {
    const negotiation = deferred<NegotiatedMobileProtocol>();
    vi.mocked(negotiateMobileProtocol).mockImplementation(({ createRestClient }) => {
      const rest = createRestClient(2);
      return negotiation.promise.then((result) => ({ ...result, rest }));
    });
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

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Connecting'));
    expect(screen.queryByTestId('chat-workspace')).toBeNull();
    expect(createdStores).toHaveLength(0);

    await act(async () => {
      negotiation.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest: {} as MobileRestClient,
      });
      await negotiation.promise;
    });

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());
    expect(createdStores).toHaveLength(1);
  });

  it('creates a v2 store and socket from the negotiated protocol and versioned REST client', async () => {
    vi.mocked(negotiateMobileProtocol).mockImplementation(async ({ createRestClient }) => ({
      version: 2,
      capabilities: ['chat-input-queue-v1'],
      rest: createRestClient(2),
    }));
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
    expect(vi.mocked(MobileRestClient).mock.calls[0][0]).toBe(
      'https://acme.relay.example.com/mobile/v2',
    );
    expect(capturedStoreDeps[0]).toMatchObject({
      protocol: { version: 2, capabilities: ['chat-input-queue-v1'] },
    });

    capturedStoreDeps[0].socketFactory(
      () => {},
      () => {},
    );
    expect(vi.mocked(ChatSocket).mock.calls[0][6]).toEqual({
      version: 2,
      capabilities: ['chat-input-queue-v1'],
    });
  });

  it('creates a v1 store after negotiation requests separately versioned v2 and v1 clients', async () => {
    vi.mocked(negotiateMobileProtocol).mockImplementation(async ({ createRestClient }) => {
      createRestClient(2);
      return { version: 1, capabilities: [], rest: createRestClient(1) };
    });
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

    expect(vi.mocked(MobileRestClient).mock.calls.map(([baseUrl]) => baseUrl)).toEqual([
      'https://acme.relay.example.com/mobile/v2',
      'https://acme.relay.example.com/mobile/v1',
    ]);
    expect(capturedStoreDeps[0]).toMatchObject({
      protocol: { version: 1, capabilities: [] },
    });
    capturedStoreDeps[0].socketFactory(
      () => {},
      () => {},
    );
    expect(vi.mocked(ChatSocket).mock.calls[0][6]).toEqual({ version: 1 });
  });

  it.each([
    ['an authentication failure after v2 health', new Error('Unauthorized')],
    ['a malformed response after v2 health', new Error('Malformed gateway identity')],
  ])('surfaces %s without constructing a fallback v1 store', async (_label, error) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(negotiateMobileProtocol).mockImplementation(async ({ createRestClient }) => {
      createRestClient(2);
      throw error;
    });
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

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(error.message));
    expect(vi.mocked(MobileRestClient).mock.calls.map(([baseUrl]) => baseUrl)).toEqual([
      'https://acme.relay.example.com/mobile/v2',
    ]);
    expect(createdStores).toHaveLength(0);
    expect(screen.queryByTestId('chat-workspace')).toBeNull();
    consoleError.mockRestore();
  });

  it('ignores a stale negotiation result after the active gateway and credential switch', async () => {
    const negotiationA = deferred<NegotiatedMobileProtocol>();
    const negotiationB = deferred<NegotiatedMobileProtocol>();
    vi.mocked(negotiateMobileProtocol).mockImplementation(({ createRestClient }) => {
      const rest = createRestClient(2);
      const baseUrl = vi.mocked(MobileRestClient).mock.calls.at(-1)?.[0] ?? '';
      const pending = baseUrl.includes('acme') ? negotiationA : negotiationB;
      return pending.promise.then((result) => ({ ...result, rest }));
    });
    const controlPlaneA = baseControlPlaneClient();
    const credentialStoreA = {
      get: vi.fn(async () => STORED),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const controlPlaneB = {
      ...baseControlPlaneClient(),
      listGateways: vi.fn(async () => [GATEWAY_B]),
    };
    const credentialStoreB = {
      get: vi.fn(async () => STORED_B),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const rendered = render(
      <Shell
        controlPlaneClient={controlPlaneA}
        credentialStore={credentialStoreA}
        relayDomain="relay.example.com"
      />,
    );
    await waitFor(() => expect(negotiateMobileProtocol).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <Shell
        controlPlaneClient={controlPlaneB}
        credentialStore={credentialStoreB}
        relayDomain="relay.example.com"
      />,
    );
    await waitFor(() => expect(negotiateMobileProtocol).toHaveBeenCalledTimes(2));

    await act(async () => {
      negotiationB.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest: {} as MobileRestClient,
      });
      await negotiationB.promise;
    });
    await waitFor(() => expect(screen.getByTestId('chat-workspace').textContent).toContain('beta'));

    await act(async () => {
      negotiationA.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest: {} as MobileRestClient,
      });
      await negotiationA.promise;
    });

    expect(createdStores).toHaveLength(1);
    expect(capturedStoreDeps[0].rest).toMatchObject({
      baseUrl: 'https://beta.relay.example.com/mobile/v2',
    });
    expect(screen.getByTestId('chat-workspace').textContent).toContain('beta');
  });

  it('lets a new credential win a same-gateway negotiation race', async () => {
    const negotiationA = deferred<NegotiatedMobileProtocol>();
    const negotiationB = deferred<NegotiatedMobileProtocol>();
    let negotiationCount = 0;
    vi.mocked(negotiateMobileProtocol).mockImplementation(({ createRestClient }) => {
      const rest = createRestClient(2);
      const pending = negotiationCount++ === 0 ? negotiationA : negotiationB;
      return pending.promise.then((result) => ({ ...result, rest }));
    });
    const refreshedCredential: StoredCredential = {
      relayCredential: 'relay-cred-refreshed',
      chatToken: 'chat-token-refreshed',
      pairingId: 'p-refreshed',
    };
    const controlPlaneClient = baseControlPlaneClient();
    const credentialStoreA = {
      get: vi.fn(async () => STORED),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const credentialStoreB = {
      get: vi.fn(async () => refreshedCredential),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const rendered = render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStoreA}
        relayDomain="relay.example.com"
      />,
    );
    await waitFor(() => expect(negotiateMobileProtocol).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStoreB}
        relayDomain="relay.example.com"
      />,
    );
    await waitFor(() => expect(negotiateMobileProtocol).toHaveBeenCalledTimes(2));

    await act(async () => {
      negotiationB.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest: {} as MobileRestClient,
      });
      await negotiationB.promise;
    });
    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());

    expect(createdStores).toHaveLength(1);
    expect(capturedStoreDeps).toHaveLength(1);
    const [, tokenSource, , relayCredential] = vi.mocked(MobileRestClient).mock.calls[1];
    await expect((tokenSource as { getToken(): Promise<string> }).getToken()).resolves.toBe(
      refreshedCredential.chatToken,
    );
    expect(relayCredential).toBe(refreshedCredential.relayCredential);
    capturedStoreDeps[0].socketFactory(
      () => {},
      () => {},
    );
    expect(vi.mocked(ChatSocket).mock.calls[0][5]).toBe(refreshedCredential.relayCredential);

    await act(async () => {
      negotiationA.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest: {} as MobileRestClient,
      });
      await negotiationA.promise;
    });

    expect(createdStores).toHaveLength(1);
    expect(capturedStoreDeps).toHaveLength(1);
    expect(ChatSocket).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending negotiation on unmount without creating a store later', async () => {
    const negotiation = deferred<NegotiatedMobileProtocol>();
    vi.mocked(negotiateMobileProtocol).mockImplementation(({ createRestClient }) => {
      const rest = createRestClient(2);
      return negotiation.promise.then((result) => ({ ...result, rest }));
    });
    const controlPlaneClient = baseControlPlaneClient();
    const credentialStore = {
      get: vi.fn(async () => STORED),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const rendered = render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );
    await waitFor(() => expect(negotiateMobileProtocol).toHaveBeenCalledTimes(1));

    rendered.unmount();
    await act(async () => {
      negotiation.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest: {} as MobileRestClient,
      });
      await negotiation.promise;
    });

    expect(createdStores).toHaveLength(0);
  });

  it('disposes the prior store exactly once before a gateway replacement and the new store on unmount', async () => {
    const negotiationB = deferred<NegotiatedMobileProtocol>();
    vi.mocked(negotiateMobileProtocol).mockImplementation(({ createRestClient }) => {
      const rest = createRestClient(2);
      const baseUrl = vi.mocked(MobileRestClient).mock.calls.at(-1)?.[0] ?? '';
      if (baseUrl.includes('beta')) {
        return negotiationB.promise.then((result) => ({ ...result, rest }));
      }
      return Promise.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest,
      });
    });
    const controlPlaneA = baseControlPlaneClient();
    const credentialStoreA = {
      get: vi.fn(async () => STORED),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const controlPlaneB = {
      ...baseControlPlaneClient(),
      listGateways: vi.fn(async () => [GATEWAY_B]),
    };
    const credentialStoreB = {
      get: vi.fn(async () => STORED_B),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const rendered = render(
      <Shell
        controlPlaneClient={controlPlaneA}
        credentialStore={credentialStoreA}
        relayDomain="relay.example.com"
      />,
    );
    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());
    expect(createdStores).toHaveLength(1);

    rendered.rerender(
      <Shell
        controlPlaneClient={controlPlaneB}
        credentialStore={credentialStoreB}
        relayDomain="relay.example.com"
      />,
    );
    await waitFor(() => expect(negotiateMobileProtocol).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(createdStores[0].getState().dispose).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('chat-workspace')).toBeNull();

    await act(async () => {
      negotiationB.resolve({
        version: 2,
        capabilities: ['chat-input-queue-v1'],
        rest: {} as MobileRestClient,
      });
      await negotiationB.promise;
    });
    await waitFor(() => expect(screen.getByTestId('chat-workspace').textContent).toContain('beta'));
    expect(createdStores).toHaveLength(2);
    expect(createdStores[0].getState().dispose).toHaveBeenCalledTimes(1);

    rendered.unmount();
    expect(createdStores[0].getState().dispose).toHaveBeenCalledTimes(1);
    expect(createdStores[1].getState().dispose).toHaveBeenCalledTimes(1);
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
      claimCredential: vi.fn(),
      getPairingStatus: vi.fn(),
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
        status: 'active' as const,
        credential: 'fresh-relay-cred',
        pairingId: 'p-1',
        chatToken: 'fresh-chat-token',
      })),
      claimCredential: vi.fn(),
      getPairingStatus: vi.fn(),
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
      claimCredential: vi.fn(),
      getPairingStatus: vi.fn(),
      listPairings: vi.fn(async () => [
        { id: 'p-1', deviceLabel: 'Web · Chrome', clientKind: 'web', status: 'active' as const },
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

    // The abandoned store (this browser's own pairing is now dead) must be
    // torn down, not left retrying in the background.
    expect(createdStores).toHaveLength(1);
    await waitFor(() => expect(createdStores[0].getState().dispose).toHaveBeenCalledTimes(1));
  });

  it("routes back to the gateway picker with the session-revoked notice when the store's connection becomes 'unauthorized', and clears the dead credential", async () => {
    const controlPlaneClient = baseControlPlaneClient();
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
    expect(createdStores).toHaveLength(1);

    // Simulate the store detecting a revoked credential (e.g. a 401 during
    // openConversation's replay, or the reconnect-exhaustion probe) — see
    // `state/store.ts` `enterUnauthorized`.
    act(() => {
      createdStores[0].setState({ connection: 'unauthorized' });
    });

    await waitFor(() => expect(screen.getByText(SESSION_REVOKED_COPY)).toBeTruthy());
    expect(screen.getByText('acme')).toBeTruthy(); // back on the gateway picker
    expect(screen.queryByTestId('chat-workspace')).toBeNull();
    expect(credentialStore.delete).toHaveBeenCalledWith('gw-1');

    // The abandoned store must be torn down too, same as self-revocation.
    await waitFor(() => expect(createdStores[0].getState().dispose).toHaveBeenCalledTimes(1));
  });

  it('still routes back to the gateway picker (and shows the notice) even if clearing the credential store fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controlPlaneClient = baseControlPlaneClient();
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(),
      delete: vi.fn(async () => {
        throw new Error('IndexedDB is unavailable');
      }),
    };

    render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());

    act(() => {
      createdStores[0].setState({ connection: 'unauthorized' });
    });

    await waitFor(() => expect(screen.getByText(SESSION_REVOKED_COPY)).toBeTruthy());
    expect(screen.queryByTestId('chat-workspace')).toBeNull();
    consoleError.mockRestore();
  });

  it('clears the session-revoked notice once a gateway is (re-)picked', async () => {
    const controlPlaneClient = {
      listGateways: vi.fn(async () => [GATEWAY]),
      createWebPairing: vi.fn(async () => ({
        status: 'active' as const,
        credential: 'fresh-relay-cred',
        pairingId: 'p-2',
        chatToken: 'fresh-chat-token',
      })),
      claimCredential: vi.fn(),
      getPairingStatus: vi.fn(),
      listPairings: vi.fn(async () => []),
      deletePairing: vi.fn(),
    };
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(async () => undefined),
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
    act(() => {
      createdStores[0].setState({ connection: 'unauthorized' });
    });
    await waitFor(() => expect(screen.getByText(SESSION_REVOKED_COPY)).toBeTruthy());

    fireEvent.click(screen.getByText('acme'));

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());
    expect(screen.queryByText(SESSION_REVOKED_COPY)).toBeNull();
  });

  it('toggles the mobile sidebar drawer via the hamburger (aria-expanded) and closes it on Escape', async () => {
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

    const hamburger = screen.getByRole('button', { name: 'Toggle conversations menu' });
    expect(hamburger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(hamburger);
    expect(hamburger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(hamburger.getAttribute('aria-expanded')).toBe('false');
  });

  it('disposes the store on unmount', async () => {
    const controlPlaneClient = baseControlPlaneClient();
    const credentialStore = {
      get: vi.fn(async (gatewayId: string) => (gatewayId === GATEWAY.gatewayId ? STORED : null)),
      set: vi.fn(),
      delete: vi.fn(),
    };

    const { unmount } = render(
      <Shell
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        relayDomain="relay.example.com"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('chat-workspace')).toBeTruthy());
    expect(createdStores).toHaveLength(1);

    unmount();

    expect(createdStores[0].getState().dispose).toHaveBeenCalledTimes(1);
  });

  describe('global keyboard shortcuts (chat-ux Phase 3 Task 5, MC parity)', () => {
    it('Cmd+K opens the mobile drawer (if closed) and focuses the conversation search input', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({ conversations: [conversationSummary()] });
      });
      await waitFor(() => expect(screen.getByLabelText(SEARCH_INPUT_LABEL)).toBeTruthy());

      const hamburger = screen.getByRole('button', { name: 'Toggle conversations menu' });
      expect(hamburger.getAttribute('aria-expanded')).toBe('false');

      fireEvent.keyDown(window, { key: 'k', metaKey: true });

      await waitFor(() => expect(hamburger.getAttribute('aria-expanded')).toBe('true'));
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText(SEARCH_INPUT_LABEL)),
      );
    });

    it('Ctrl+K also focuses the search input, directly, once the drawer is already open', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({ conversations: [conversationSummary()] });
      });
      await waitFor(() => expect(screen.getByLabelText(SEARCH_INPUT_LABEL)).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Toggle conversations menu' }));
      expect(
        screen
          .getByRole('button', { name: 'Toggle conversations menu' })
          .getAttribute('aria-expanded'),
      ).toBe('true');

      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText(SEARCH_INPUT_LABEL)),
      );
    });

    it('a bare "k" with no modifier does nothing — never opens the drawer or moves focus', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({ conversations: [conversationSummary()] });
      });
      await waitFor(() => expect(screen.getByLabelText(SEARCH_INPUT_LABEL)).toBeTruthy());
      const hamburger = screen.getByRole('button', { name: 'Toggle conversations menu' });

      fireEvent.keyDown(window, { key: 'k' });

      expect(hamburger.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).not.toBe(screen.getByLabelText(SEARCH_INPUT_LABEL));
    });

    it("Cmd+Shift+O starts a new conversation via ConversationList's own new-conversation flow", async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({ conversations: [conversationSummary()] });
      });
      await waitFor(() => expect(screen.getByText(NEW_CONVERSATION_LABEL)).toBeTruthy());

      fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });

      await waitFor(() => expect(createdStores[0].getState().listAgents).toHaveBeenCalledTimes(1));
    });

    it('final-review fix I1: rapid key-repeat on Cmd+Shift+O only starts one conversation (reentrancy guard armed before the first await)', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({ conversations: [conversationSummary()] });
      });
      await waitFor(() => expect(screen.getByText(NEW_CONVERSATION_LABEL)).toBeTruthy());

      // Three keydowns fired back-to-back, synchronously, with no `await` in
      // between — the same shape a held/repeating key produces. Each one
      // re-enters `ConversationList`'s `handleNewConversation` via
      // `newConversationRef.current?.()` before the first invocation's
      // `listAgents()` promise has had a chance to resolve.
      fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
      fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
      fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });

      await waitFor(() => expect(createdStores[0].getState().listAgents).toHaveBeenCalledTimes(1));
      // Give any wrongly-reentered second/third call a chance to have fired
      // its own `listAgents()` before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(createdStores[0].getState().listAgents).toHaveBeenCalledTimes(1);
    });

    it('Cmd+Shift+O switches off the Devices screen before starting a new conversation', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({ conversations: [conversationSummary()] });
      });
      await waitFor(() => expect(screen.getByText(NEW_CONVERSATION_LABEL)).toBeTruthy());

      fireEvent.click(screen.getByText('Devices'));
      await waitFor(() => expect(screen.queryByText(NEW_CONVERSATION_LABEL)).toBeNull());

      fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true });

      await waitFor(() =>
        expect(screen.getByText('Conversations').getAttribute('aria-current')).toBe('page'),
      );
      await waitFor(() => expect(createdStores[0].getState().listAgents).toHaveBeenCalledTimes(1));
    });

    it('Escape stops generation (cancelTurn) while the open conversation is streaming, and does not also close an already-open drawer', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({
          conversations: [conversationSummary()],
          transcripts: {
            'conv-1': { messages: [], streaming: { type: 'assistant', events: [] } },
          },
        });
      });
      await waitFor(() => expect(screen.getByText('Chat about the roadmap')).toBeTruthy());
      fireEvent.click(screen.getByText('Chat about the roadmap'));

      fireEvent.click(screen.getByRole('button', { name: 'Toggle conversations menu' }));
      const hamburger = screen.getByRole('button', { name: 'Toggle conversations menu' });
      expect(hamburger.getAttribute('aria-expanded')).toBe('true');

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(createdStores[0].getState().cancelTurn).toHaveBeenCalledWith('conv-1');
      // Streaming takes priority over the drawer — the SAME Escape must not
      // also close it (see `ChatWorkspace`'s doc comment on the precedence).
      expect(hamburger.getAttribute('aria-expanded')).toBe('true');
    });

    it("Escape lets an open edit editor's own handling win — it neither calls cancelTurn nor is double-handled", async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({
          conversations: [conversationSummary()],
          transcripts: {
            'conv-1': { messages: [conversationMessage()], streaming: null },
          },
        });
      });
      fireEvent.click(screen.getByText('Chat about the roadmap'));

      const editButton = await screen.findByRole('button', {
        name: 'Edit and resend this message',
      });
      fireEvent.click(editButton);

      const editTextarea = await screen.findByLabelText('Edit message');
      fireEvent.keyDown(editTextarea, { key: 'Escape' });

      expect(createdStores[0].getState().cancelTurn).not.toHaveBeenCalled();
      // The editor's own onKeyDown (not this global handler) closed it.
      await waitFor(() => expect(screen.queryByLabelText('Edit message')).toBeNull());
    });

    it('final-review fix I2: Escape cancelling an open rename does not also cancelTurn, even while the conversation is streaming', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({
          conversations: [conversationSummary()],
          transcripts: {
            'conv-1': { messages: [], streaming: { type: 'assistant', events: [] } },
          },
        });
      });
      await waitFor(() => expect(screen.getByText('Chat about the roadmap')).toBeTruthy());
      fireEvent.click(screen.getByText('Chat about the roadmap')); // selects conv-1

      fireEvent.click(screen.getByLabelText(RENAME_ACTION_LABEL));
      const input = screen.getByDisplayValue('Chat about the roadmap');
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(createdStores[0].getState().cancelTurn).not.toHaveBeenCalled();
      // The rename input's own Escape handling closed it (reverted, not committed).
      expect(screen.queryByDisplayValue('Chat about the roadmap')).toBeNull();
      expect(screen.getByText('Chat about the roadmap')).toBeTruthy();
    });

    it('final-review fix I2: Escape while the delete confirm is open dismisses the confirm, not cancelTurn, even while streaming', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({
          conversations: [conversationSummary()],
          transcripts: {
            'conv-1': { messages: [], streaming: { type: 'assistant', events: [] } },
          },
        });
      });
      await waitFor(() => expect(screen.getByText('Chat about the roadmap')).toBeTruthy());
      fireEvent.click(screen.getByText('Chat about the roadmap')); // selects conv-1

      fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));
      expect(screen.getByText(DELETE_CONFIRM_COPY)).toBeTruthy();

      fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });

      expect(createdStores[0].getState().cancelTurn).not.toHaveBeenCalled();
      expect(screen.queryByText(DELETE_CONFIRM_COPY)).toBeNull();
    });

    it("lets the delivery chooser own Escape instead of also cancelling the conversation's turn", async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({
          conversations: [conversationSummary()],
          transcripts: {
            'conv-1': { messages: [], streaming: { type: 'assistant', events: [] } },
          },
        });
      });
      await waitFor(() => expect(screen.getByText('Chat about the roadmap')).toBeTruthy());
      fireEvent.click(screen.getByText('Chat about the roadmap'));

      const chooser = document.createElement('div');
      chooser.className = 'delivery-chooser';
      const chooserButton = document.createElement('button');
      chooser.append(chooserButton);
      document.body.append(chooser);

      fireEvent.keyDown(chooserButton, { key: 'Escape' });

      expect(createdStores[0].getState().cancelTurn).not.toHaveBeenCalled();
      chooser.remove();
    });

    // Re-review regression guard for fix I2. The "Escape stops generation"
    // test above dispatches on `window`, whose `event.target` is the window
    // itself — not an `Element` — so it sails past the bail-out entirely and
    // cannot observe it. A real Escape targets the FOCUSED element, and
    // clicking a conversation row leaves focus on that row's button, so I2's
    // first (blanket `.conversation-list`) selector silently swallowed it.
    it('Escape still stops generation when focus is resting on a conversation row (fix I2 must not over-bail)', async () => {
      await renderChatWorkspace();
      act(() => {
        createdStores[0].setState({
          conversations: [conversationSummary()],
          transcripts: {
            'conv-1': { messages: [], streaming: { type: 'assistant', events: [] } },
          },
        });
      });
      await waitFor(() => expect(screen.getByText('Chat about the roadmap')).toBeTruthy());
      const row = screen.getByText('Chat about the roadmap').closest('button') as HTMLButtonElement;
      fireEvent.click(row);
      row.focus();
      expect(document.activeElement).toBe(row);

      fireEvent.keyDown(row, { key: 'Escape' });

      expect(createdStores[0].getState().cancelTurn).toHaveBeenCalledWith('conv-1');
    });
  });
});
