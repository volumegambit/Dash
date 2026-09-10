import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2ConversationMessagePage,
  MobileV2ConversationSummary,
  MobileV2PendingInput,
  MobileV2SequencedFrame,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import type { ChatSocket, ChatSocketClose, FrameHandler } from '../api/chat-socket';
import { MobileApiError, type MobileRestClient } from '../api/rest';
import {
  RECONNECT_BASE_MS,
  RECONNECT_FACTOR,
  RECONNECT_MAX_MS,
  type WebAppStoreDeps,
  type WebChatProtocol,
  createWebAppStore,
} from './store';

// apps/web/src/state -> apps/web -> apps -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES_DIR = join(REPO_ROOT, 'contracts/mobile/v1/fixtures');

function readJsonl<T>(file: string): T[] {
  return readFileSync(join(FIXTURES_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

const CONVERSATION_ID = 'conv-1';
const V1_PROTOCOL: WebChatProtocol = { version: 1, capabilities: [] };
const V2_PROTOCOL: WebChatProtocol = {
  version: 2,
  capabilities: ['chat-input-queue-v1'],
};
const RETRYABLE_ERROR_CLOSE: ChatSocketClose = { kind: 'error', retryable: true };
const RETRYABLE_CLOSED_CLOSE: ChatSocketClose = {
  kind: 'closed',
  code: 1006,
  reason: '',
  retryable: true,
};

function createTestStore(
  deps: Omit<WebAppStoreDeps, 'protocol'> & { protocol?: WebAppStoreDeps['protocol'] },
): ReturnType<typeof createWebAppStore> {
  return createWebAppStore({ protocol: V1_PROTOCOL, ...deps });
}

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: CONVERSATION_ID,
    agentId: 'agent-01',
    agentName: 'Mobile Helper',
    title: 'Mobile launch check',
    revision: 1,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: null,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    conversationId: CONVERSATION_ID,
    turnId: 'turn-1',
    ordinal: 1,
    role: 'user',
    status: 'completed',
    content: { type: 'user', text: 'hi' },
    createdAt: '2026-07-12T00:00:01.000Z',
    updatedAt: '2026-07-12T00:00:01.000Z',
    ...overrides,
  };
}

function v2Summary(
  overrides: Partial<MobileV2ConversationSummary> = {},
): MobileV2ConversationSummary {
  return {
    ...summary(),
    queuePaused: false,
    queueRevision: 0,
    pendingFollowUpCount: 0,
    v2LastSeq: 0,
    ...overrides,
  };
}

function v2Message(
  overrides: Partial<MobileV2ConversationMessage> = {},
): MobileV2ConversationMessage {
  return {
    ...message(),
    runId: 'run-1',
    segmentIndex: 0,
    deliveryKind: 'normal',
    ...overrides,
  };
}

function pendingInput(overrides: Partial<MobileV2PendingInput> = {}): MobileV2PendingInput {
  return {
    inputId: 'input-1',
    kind: 'follow_up',
    text: 'next',
    state: 'queued',
    revision: 1,
    enqueueOrder: 1,
    createdAt: '2026-07-12T00:00:02.000Z',
    updatedAt: '2026-07-12T00:00:02.000Z',
    ...overrides,
  };
}

function v2Bootstrap(
  overrides: Partial<MobileV2ConversationBootstrap> = {},
): MobileV2ConversationBootstrap {
  return {
    conversation: v2Summary(),
    messages: [],
    nextCursor: null,
    pendingInputs: [],
    queuePaused: false,
    queueRevision: 0,
    v2ThroughSeq: 0,
    ...overrides,
  };
}

/** A hand-scripted stand-in for `ChatSocket` (Task 9), same spirit as its own
 * `ScriptedWebSocket` test double: `connect()` settles on demand rather than
 * immediately, so tests can drive reconnect timing precisely. */
type TestClientFrame = MobileWsClientFrame | Exclude<MobileV2WsClientFrame, { type: 'hello' }>;

class ScriptedChatSocket {
  readonly sent: TestClientFrame[] = [];
  closed = false;
  /** When set, `send()` throws synchronously instead of recording the frame
   * — simulates the socket having gone stale between `connect()` resolving
   * and the caller actually writing to it (see the ChatSocket contract:
   * `send()` throws if the socket isn't open). */
  sendShouldThrow = false;
  private settle: ((outcome: 'resolve' | 'reject') => void) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settle = (outcome) => (outcome === 'resolve' ? resolve() : reject(new Error('boom')));
    });
  }

  send(frame: MobileWsClientFrame | MobileV2WsClientFrame): void {
    if (this.sendShouldThrow) {
      throw new Error('ChatSocket: cannot send while the socket is not open');
    }
    this.sent.push(frame as TestClientFrame);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.settle?.('resolve');
  }

  failToOpen(): void {
    this.settle?.('reject');
  }
}

interface ScriptedFactory {
  factory: (onFrame: FrameHandler, onClose: (close: ChatSocketClose) => void) => ChatSocket;
  sockets: ScriptedChatSocket[];
  onFrames: FrameHandler[];
  onCloses: Array<(close: ChatSocketClose) => void>;
}

function scriptedSocketFactory(): ScriptedFactory {
  const sockets: ScriptedChatSocket[] = [];
  const onFrames: FrameHandler[] = [];
  const onCloses: Array<(close: ChatSocketClose) => void> = [];
  const factory = vi.fn((onFrame: FrameHandler, onClose: (close: ChatSocketClose) => void) => {
    const socket = new ScriptedChatSocket();
    sockets.push(socket);
    onFrames.push(onFrame);
    onCloses.push(onClose);
    return socket as unknown as ChatSocket;
  });
  return { factory, sockets, onFrames, onCloses };
}

interface FakeRest {
  rest: MobileRestClient;
  listConversations: ReturnType<typeof vi.fn>;
  getMessages: ReturnType<typeof vi.fn>;
  identity: ReturnType<typeof vi.fn>;
  createConversation: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
  patchConversation: ReturnType<typeof vi.fn>;
  deleteConversation: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
  bootstrap: ReturnType<typeof vi.fn>;
  getMessagesV2: ReturnType<typeof vi.fn>;
}

function fakeRest(opts: {
  conversationPage?: ConversationPage;
  messagePages?: ConversationMessagePage[];
  /** Override for `rest.listConversations()` — takes precedence over
   * `conversationPage` when set. Used by tests simulating a 401 (revoked
   * credential) on this call, whether from `loadConversations()` directly or
   * `resolveAgentId`'s fallback fetch during a reconnect. */
  listConversationsImpl?: () => Promise<ConversationPage>;
  /** Override for `rest.getMessages()` — used by tests simulating a 401 on
   * the initial `openConversation()` replay. */
  getMessagesImpl?: (conversationId: string, cursor?: string) => Promise<ConversationMessagePage>;
  /** Override for `rest.identity()` — defaults to a successful resolve.
   * `finalizeReconnectExhausted` (store.ts) probes this once the reconnect-
   * attempt cap is hit, so every test that drives a store past that cap
   * needs *some* `identity()` behavior; tests simulating a remotely-revoked
   * credential pass a rejecting fn here. */
  identityImpl?: () => Promise<unknown>;
  /** Override for `rest.createConversation()` — used by `startConversation`
   * tests, including one simulating a REST failure. */
  createConversationImpl?: (req: unknown) => Promise<ConversationSummary>;
  /** Override for `rest.listAgents()`. */
  listAgentsImpl?: () => Promise<unknown[]>;
  /** Override for `rest.patchConversation()` — used by `renameConversation` tests. */
  patchConversationImpl?: (
    conversationId: string,
    patch: unknown,
    revision: number,
  ) => Promise<ConversationSummary>;
  /** Override for `rest.deleteConversation()` — used by `deleteConversation` tests. */
  deleteConversationImpl?: (
    conversationId: string,
    revision: number,
  ) => Promise<ConversationSummary>;
  /** Override for `rest.getConversation()` — used by the auto-title-refresh tests. */
  getConversationImpl?: (conversationId: string) => Promise<ConversationSummary>;
  bootstrapImpl?: (conversationId: string) => Promise<MobileV2ConversationBootstrap>;
  getMessagesV2Impl?: (
    conversationId: string,
    before?: string,
    limit?: number,
  ) => Promise<MobileV2ConversationMessagePage>;
}): FakeRest {
  const messagePages = opts.messagePages ?? [{ items: [], nextCursor: null, throughSeq: 0 }];
  let getMessagesCall = 0;
  const listConversations = vi.fn(
    opts.listConversationsImpl ??
      (async () => opts.conversationPage ?? { items: [summary()], nextCursor: null }),
  );
  const getMessages = vi.fn(
    opts.getMessagesImpl ??
      (async (_conversationId: string, _cursor?: string) => {
        const page = messagePages[Math.min(getMessagesCall, messagePages.length - 1)];
        getMessagesCall += 1;
        return page;
      }),
  );
  const identity = vi.fn(
    opts.identityImpl ?? (async () => ({ gatewayId: 'gw-1', publicKey: 'pk-stub' })),
  );
  const createConversation = vi.fn(
    opts.createConversationImpl ?? (async () => summary({ id: 'new-conv' })),
  );
  const listAgents = vi.fn(opts.listAgentsImpl ?? (async () => []));
  const patchConversation = vi.fn(
    opts.patchConversationImpl ??
      (async (conversationId: string, patch: unknown, revision: number) =>
        summary({ id: conversationId, ...(patch as object), revision: revision + 1 })),
  );
  const deleteConversation = vi.fn(
    opts.deleteConversationImpl ??
      (async (conversationId: string, revision: number) =>
        summary({ id: conversationId, status: 'deleted', revision: revision + 1 })),
  );
  const getConversation = vi.fn(
    opts.getConversationImpl ?? (async (conversationId: string) => summary({ id: conversationId })),
  );
  const bootstrap = vi.fn(
    opts.bootstrapImpl ??
      (async (conversationId: string) =>
        v2Bootstrap({ conversation: v2Summary({ id: conversationId }) })),
  );
  const getMessagesV2 = vi.fn(
    opts.getMessagesV2Impl ?? (async () => ({ items: [], nextCursor: null, throughSeq: 0 })),
  );
  const rest = {
    listConversations,
    getMessages,
    identity,
    createConversation,
    listAgents,
    patchConversation,
    deleteConversation,
    getConversation,
    bootstrap,
    getMessagesV2,
  } as unknown as MobileRestClient;
  return {
    rest,
    listConversations,
    getMessages,
    identity,
    createConversation,
    listAgents,
    patchConversation,
    deleteConversation,
    getConversation,
    bootstrap,
    getMessagesV2,
  };
}

/** Drives a store through `openConversation`, resolving the scripted
 * socket's `connect()` once it exists. Returns once fully connected. */
async function openAndConnect(
  store: ReturnType<typeof createWebAppStore>,
  sockets: ScriptedChatSocket[],
  conversationId: string,
): Promise<ScriptedChatSocket> {
  const opening = store.getState().openConversation(conversationId);
  const countBefore = sockets.length;
  await vi.waitFor(() => expect(sockets.length).toBe(countBefore + 1));
  const socket = sockets[countBefore];
  socket.open();
  await opening;
  return socket;
}

function inputFrame(
  type: 'input_accepted' | 'input_updated' | 'input_removed' | 'input_failed',
  v2Seq: number,
  input: MobileV2PendingInput,
  overrides: Partial<MobileV2SequencedFrame> = {},
): MobileV2SequencedFrame {
  return {
    type,
    id: `command-${v2Seq}`,
    conversationId: CONVERSATION_ID,
    v2Seq,
    queueRevision: input.revision,
    input,
    ...overrides,
  } as MobileV2SequencedFrame;
}

function acceptedFrame(
  v2Seq: number,
  overrides: Partial<Extract<MobileV2SequencedFrame, { type: 'accepted' }>> = {},
): Extract<MobileV2SequencedFrame, { type: 'accepted' }> {
  return {
    type: 'accepted',
    id: `command-${v2Seq}`,
    conversationId: CONVERSATION_ID,
    runId: `run-${v2Seq}`,
    segmentTurnId: `segment-${v2Seq}`,
    v2Seq,
    userMessageId: `user-${v2Seq}`,
    assistantMessageId: `assistant-${v2Seq}`,
    revision: v2Seq + 1,
    ...overrides,
  };
}

function eventFrame(
  v2Seq: number,
  overrides: Partial<Extract<MobileV2SequencedFrame, { type: 'event' }>> = {},
): Extract<MobileV2SequencedFrame, { type: 'event' }> {
  return {
    type: 'event',
    id: `event-${v2Seq}`,
    conversationId: CONVERSATION_ID,
    runId: `run-${v2Seq}`,
    segmentTurnId: `segment-${v2Seq}`,
    v2Seq,
    event: { type: 'text_delta', text: `delta-${v2Seq}` },
    ...overrides,
  };
}

function doneFrame(
  v2Seq: number,
  overrides: Partial<Extract<MobileV2SequencedFrame, { type: 'done' }>> = {},
): Extract<MobileV2SequencedFrame, { type: 'done' }> {
  return {
    type: 'done',
    id: `done-${v2Seq}`,
    conversationId: CONVERSATION_ID,
    runId: `run-${v2Seq}`,
    segmentTurnId: `segment-${v2Seq}`,
    v2Seq,
    outcome: 'completed',
    ...overrides,
  };
}

function deliveredFrame(
  v2Seq: number,
  input: MobileV2PendingInput,
  overrides: Partial<Extract<MobileV2SequencedFrame, { type: 'input_delivered' }>> = {},
): Extract<MobileV2SequencedFrame, { type: 'input_delivered' }> {
  return {
    type: 'input_delivered',
    id: `delivered-${v2Seq}`,
    conversationId: CONVERSATION_ID,
    v2Seq,
    queueRevision: input.revision,
    input,
    runId: `run-${v2Seq}`,
    segmentTurnId: `segment-${v2Seq}`,
    userMessageId: `user-${v2Seq}`,
    assistantMessageId: `assistant-${v2Seq}`,
    ...overrides,
  };
}

function subscriptionFrame(
  socket: ScriptedChatSocket,
  conversationId = CONVERSATION_ID,
  occurrence = 0,
): Extract<MobileV2WsClientFrame, { type: 'subscribe_conversation' }> {
  const subscriptions = socket.sent.filter(
    (frame): frame is Extract<MobileV2WsClientFrame, { type: 'subscribe_conversation' }> =>
      frame.type === 'subscribe_conversation' && frame.conversationId === conversationId,
  );
  const subscription = subscriptions[occurrence];
  if (!subscription) throw new Error(`expected v2 subscription ${occurrence}`);
  return subscription;
}

function acknowledgeSubscription(
  scripted: ScriptedFactory,
  socketIndex: number,
  conversationId = CONVERSATION_ID,
  occurrence = 0,
): void {
  const subscription = subscriptionFrame(scripted.sockets[socketIndex], conversationId, occurrence);
  scripted.onFrames[socketIndex]({
    type: 'conversation_subscribed',
    id: subscription.id,
    conversationId,
    v2ThroughSeq: subscription.sinceV2Seq,
  });
}

async function openV2Conversation(
  store: ReturnType<typeof createWebAppStore>,
  scripted: ScriptedFactory,
  conversationId = CONVERSATION_ID,
): Promise<ScriptedChatSocket> {
  const socketIndex = scripted.sockets.length;
  const opening = store.getState().openConversation(conversationId);
  await vi.waitFor(() => expect(scripted.sockets.length).toBe(socketIndex + 1));
  const socket = scripted.sockets[socketIndex];
  socket.open();
  await vi.waitFor(() =>
    expect(socket.sent.some((frame) => frame.type === 'subscribe_conversation')).toBe(true),
  );
  const subscription = socket.sent.find(
    (frame): frame is Extract<MobileV2WsClientFrame, { type: 'subscribe_conversation' }> =>
      frame.type === 'subscribe_conversation',
  );
  if (!subscription) throw new Error('expected a v2 subscription');
  acknowledgeSubscription(scripted, socketIndex, conversationId);
  await opening;
  return socket;
}

describe('createWebAppStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it("starts with connection 'idle' — not 'offline' — before anything has ever gone wrong", () => {
      const { rest } = fakeRest({});
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      expect(store.getState().connection).toBe('idle');
      expect(store.getState().protocol).toEqual(V1_PROTOCOL);
      expect(store.getState().v2Transcripts).toEqual({});
    });

    it("a healthy loadConversations() on an empty account leaves connection 'idle' (not reinterpreted as an outage)", async () => {
      const { rest } = fakeRest({ conversationPage: { items: [], nextCursor: null } });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await store.getState().loadConversations();

      expect(store.getState().conversations).toEqual([]);
      expect(store.getState().connection).toBe('idle');
    });
  });

  describe('loadConversations', () => {
    it('populates conversations from the REST client', async () => {
      const page = { items: [summary(), summary({ id: 'conv-2' })], nextCursor: null };
      const { rest } = fakeRest({ conversationPage: page });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await store.getState().loadConversations();

      expect(store.getState().conversations).toEqual(page.items);
    });

    it('does not let a delayed v2 list replace newer live state or a conversation added after the request began', async () => {
      let resolvePage!: (page: ConversationPage) => void;
      const delayedPage = new Promise<ConversationPage>((resolve) => {
        resolvePage = resolve;
      });
      const original = v2Summary({
        title: 'Newer REST metadata',
        revision: 10,
        status: 'running',
        activeTurnId: 'captured-run',
        queueRevision: 3,
        pendingFollowUpCount: 1,
        v2LastSeq: 5,
      });
      const live = v2Summary({
        revision: 9,
        status: 'idle',
        activeTurnId: null,
        queuePaused: true,
        queueRevision: 4,
        pendingFollowUpCount: 2,
        v2LastSeq: 6,
      });
      const added = v2Summary({ id: 'locally-added', title: 'Created while loading' });
      const { rest } = fakeRest({ listConversationsImpl: async () => delayedPage });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: factory,
      });
      store.setState({ conversations: [original] });

      const loading = store.getState().loadConversations();
      store.setState({ conversations: [added, live] });
      resolvePage({ items: [original], nextCursor: null });
      await loading;

      expect(store.getState().conversations).toEqual([
        added,
        {
          ...original,
          status: live.status,
          activeTurnId: live.activeTurnId,
          queuePaused: live.queuePaused,
          queueRevision: live.queueRevision,
          pendingFollowUpCount: live.pendingFollowUpCount,
          v2LastSeq: live.v2LastSeq,
        },
      ]);
    });

    it('ignores an older overlapping v2 list response after a newer request removed a remote row', async () => {
      let resolveFirst!: (page: ConversationPage) => void;
      let resolveSecond!: (page: ConversationPage) => void;
      const firstPage = new Promise<ConversationPage>((resolve) => {
        resolveFirst = resolve;
      });
      const secondPage = new Promise<ConversationPage>((resolve) => {
        resolveSecond = resolve;
      });
      let request = 0;
      const remote = v2Summary({ id: 'remote-row' });
      const { rest } = fakeRest({
        listConversationsImpl: async () => {
          request += 1;
          return request === 1 ? firstPage : secondPage;
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: factory,
      });
      store.setState({ conversations: [remote] });

      const olderLoad = store.getState().loadConversations();
      const newerLoad = store.getState().loadConversations();
      resolveSecond({ items: [], nextCursor: null });
      await newerLoad;
      expect(store.getState().conversations).toEqual([]);

      resolveFirst({ items: [remote], nextCursor: null });
      await olderLoad;
      expect(store.getState().conversations).toEqual([]);
    });

    it('installs a reconciled v2 list summary into the retained transcript projection', async () => {
      const remote = v2Summary({
        title: 'Remote title',
        revision: 8,
        queueRevision: 5,
        pendingFollowUpCount: 2,
        v2LastSeq: 5,
      });
      const { rest } = fakeRest({
        conversationPage: { items: [remote], nextCursor: null },
        bootstrapImpl: async () =>
          v2Bootstrap({ conversation: v2Summary({ title: 'Old title', revision: 7 }) }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      await store.getState().loadConversations();
      expect(store.getState().conversations[0].title).toBe('Remote title');
      expect((store.getState().conversations[0] as MobileV2ConversationSummary).v2LastSeq).toBe(5);
      expect(store.getState().v2Transcripts[CONVERSATION_ID]).toMatchObject({
        lastAppliedV2Seq: 0,
        conversation: { title: 'Remote title', v2LastSeq: 0, queueRevision: 0 },
      });

      scripted.onFrames[0](inputFrame('input_accepted', 1, pendingInput()));
      expect(store.getState().conversations[0].title).toBe('Remote title');
      expect((store.getState().conversations[0] as MobileV2ConversationSummary).v2LastSeq).toBe(5);
      expect(store.getState().v2Transcripts[CONVERSATION_ID].inputs).toHaveProperty('input-1');
    });
  });

  describe('listAgents', () => {
    it('delegates to rest.listAgents()', async () => {
      const agents = [
        {
          id: 'agent-1',
          name: 'Mobile Helper',
          config: { name: 'Mobile Helper', model: 'anthropic/claude', systemPrompt: 'Help.' },
          status: 'active',
          registeredAt: '2026-07-12T00:00:00.000Z',
        },
      ];
      const { rest, listAgents } = fakeRest({ listAgentsImpl: async () => agents });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await expect(store.getState().listAgents()).resolves.toEqual(agents);
      expect(listAgents).toHaveBeenCalledTimes(1);
    });
  });

  describe('startConversation', () => {
    it('creates a conversation via REST, adds it to the list, and opens it', async () => {
      const created = summary({ id: 'new-conv', agentId: 'agent-02', title: 'Fresh chat' });
      const { rest, createConversation } = fakeRest({
        createConversationImpl: async () => created,
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      const starting = store.getState().startConversation('agent-02', 'Fresh chat');
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      sockets[0].open();
      const result = await starting;

      expect(createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-02', title: 'Fresh chat' }),
      );
      const sentRequestId = createConversation.mock.calls[0][0].requestId;
      expect(typeof sentRequestId).toBe('string');
      expect(sentRequestId.length).toBeGreaterThan(0);

      expect(result).toEqual(created);
      expect(store.getState().conversations).toContainEqual(created);
      expect(store.getState().connection).toBe('connected');
    });

    it('omits a title when none is given', async () => {
      const { rest, createConversation } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      const starting = store.getState().startConversation('agent-02');
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      sockets[0].open();
      await starting;

      expect(createConversation.mock.calls[0][0].title).toBeUndefined();
    });

    it('propagates a REST failure from createConversation instead of swallowing it into a connection state', async () => {
      const { rest, createConversation } = fakeRest({
        createConversationImpl: async () => {
          throw new Error('gateway rejected the create');
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await expect(store.getState().startConversation('agent-02')).rejects.toThrow(
        'gateway rejected the create',
      );
      expect(createConversation).toHaveBeenCalledTimes(1);
      expect(store.getState().conversations).toEqual([]);
      expect(store.getState().connection).toBe('idle'); // untouched — not reinterpreted as an outage
    });
  });

  describe('openConversation', () => {
    it('replays every backward-paginated message page before attaching the socket', async () => {
      const older = message({ id: 'msg-a', ordinal: 1 });
      const newer = message({ id: 'msg-b', ordinal: 2 });
      const { rest, getMessages } = fakeRest({
        messagePages: [
          { items: [newer], nextCursor: 'cursor-1', throughSeq: 5 },
          { items: [older], nextCursor: null, throughSeq: 5 },
        ],
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await openAndConnect(store, sockets, CONVERSATION_ID);

      // Oldest-first, reconstructed from the two backward pages.
      expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toEqual([older, newer]);
      expect(getMessages).toHaveBeenNthCalledWith(1, CONVERSATION_ID, undefined);
      expect(getMessages).toHaveBeenNthCalledWith(2, CONVERSATION_ID, 'cursor-1');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(store.getState().connection).toBe('connected');
    });

    it('merges re-replayed history with local state by turnId, dropping a stale optimistic stand-in', async () => {
      // Regression for: reopening a conversation after sendMessage() added an
      // optimistic (unreconciled) local message, where the server has since
      // assigned it a real id — the merge must not keep both.
      let getMessagesCall = 0;
      let secondPageItems: ConversationMessage[] = [];
      const rest = {
        listConversations: vi.fn(async () => ({ items: [summary()], nextCursor: null })),
        getMessages: vi.fn(async () => {
          const page =
            getMessagesCall === 0
              ? { items: [], nextCursor: null, throughSeq: 0 }
              : { items: secondPageItems, nextCursor: null, throughSeq: 1 };
          getMessagesCall += 1;
          return page;
        }),
      } as unknown as MobileRestClient;
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await openAndConnect(store, sockets, CONVERSATION_ID);
      await store.getState().sendMessage(CONVERSATION_ID, 'quick note');
      const optimistic = store.getState().transcripts[CONVERSATION_ID]?.messages[0];
      expect(optimistic).toBeDefined();
      const turnId = optimistic?.turnId as string;

      // The server now has the authoritative message for that same turn,
      // under a different (server-assigned) id.
      secondPageItems = [message({ id: 'server-msg-1', turnId, ordinal: 1, status: 'completed' })];

      await openAndConnect(store, sockets, CONVERSATION_ID);

      const finalMessages = store.getState().transcripts[CONVERSATION_ID]?.messages ?? [];
      expect(finalMessages.map((m) => m.id)).toEqual(['server-msg-1']);
    });

    it("a non-auth failure during the initial replay reconnects on the normal backoff instead of stranding the store (regression: used to rethrow, leaving a fresh store stuck on 'idle' with no banner, no indicator, and no retry ever scheduled)", async () => {
      const { rest } = fakeRest({
        getMessagesImpl: async () => {
          throw new TypeError('fetch failed'); // a plain network error, not MobileApiError
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({
        rest,
        socketFactory: factory,
        reconnect: { maxAttempts: 1 },
      });

      // Resolves — never rejects on a transport failure; the only caller is
      // a React effect.
      await store.getState().openConversation(CONVERSATION_ID);
      expect(store.getState().connection).toBe('reconnecting');
      // No socket was ever attempted for the failed replay itself.
      expect(factory).not.toHaveBeenCalled();

      // A reconnect was armed on the normal backoff schedule.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));

      // And cap-exhaustion still ends 'offline', same as any other reconnect path.
      sockets[0].failToOpen(); // cap reached (maxAttempts: 1) — probe fires
      await vi.waitFor(() => expect(store.getState().connection).toBe('offline'));
    });
  });

  describe('sendMessage', () => {
    it('optimistically appends the user message and sends a ChatSend frame', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await openAndConnect(store, sockets, CONVERSATION_ID);
      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');

      const transcript = store.getState().transcripts[CONVERSATION_ID];
      expect(transcript?.messages).toHaveLength(1);
      expect(transcript?.messages[0]).toMatchObject({
        role: 'user',
        content: { type: 'user', text: 'hello there' },
      });

      expect(sockets[0].sent).toHaveLength(1);
      const sent = sockets[0].sent[0];
      expect(sent).toMatchObject({
        type: 'message',
        agentId: 'agent-01',
        conversationId: CONVERSATION_ID,
        text: 'hello there',
        resumable: true,
      });
      expect(typeof (sent as { channelId?: string }).channelId).toBe('string');
    });

    it('attaches the coarse client location to the ChatSend frame', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'where am I?');

      const sent = sockets[0].sent[0] as { location?: Record<string, unknown> };
      expect(sent.location).toBeDefined();
      // jsdom reports a real IANA zone and BCP-47 tag, so this asserts the
      // shape the gateway validator requires rather than pinning a machine's
      // own zone: an empty string there would make the gateway drop the whole
      // coarse tier.
      expect(typeof sent.location?.timezone).toBe('string');
      expect(sent.location?.timezone).not.toBe('');
      expect(typeof sent.location?.locale).toBe('string');
      expect(sent.location?.locale).not.toBe('');
      expect(Number.isInteger(sent.location?.utcOffsetMinutes)).toBe(true);
      // Minutes EAST of UTC, so it must be the negation of the JS west-positive value.
      expect(sent.location?.utcOffsetMinutes).toBe(-new Date().getTimezoneOffset());
    });

    // Chat UX Phase 4 Task 5 (audit #14 remainder): web attachments. Images
    // ride on the same `message` frame iOS/MC send (`MobileWsClientFrame`
    // `images`), and the optimistic user message carries them too so the
    // transcript shows the thumbnails before the gateway echoes them back.
    it('sends images on the optimistic user message and in the ChatSend frame', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const images = [{ mediaType: 'image/png' as const, data: 'aGVsbG8=' }];
      await store.getState().sendMessage(CONVERSATION_ID, '', images);

      expect(store.getState().transcripts[CONVERSATION_ID]?.messages[0]).toMatchObject({
        role: 'user',
        content: { type: 'user', text: '', images },
      });
      expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: '', images });
    });

    it('omits the images field from the frame and the optimistic message when none are attached', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'text only');

      expect('images' in (sockets[0].sent[0] as object)).toBe(false);
      const content = store.getState().transcripts[CONVERSATION_ID]?.messages[0]?.content;
      expect(content && 'images' in content).toBe(false);
    });

    it('throws and adds no optimistic message when not connected', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE);
      expect(store.getState().connection).toBe('reconnecting');

      await expect(store.getState().sendMessage(CONVERSATION_ID, 'hello')).rejects.toThrow();
      expect(store.getState().transcripts[CONVERSATION_ID]?.messages ?? []).toHaveLength(0);
    });

    it('marks the optimistic message failed (not stuck "accepted") when socket.send() throws', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      socket.sendShouldThrow = true;
      await expect(store.getState().sendMessage(CONVERSATION_ID, 'fails')).rejects.toThrow();

      expect(socket.sent).toHaveLength(0);
      const transcript = store.getState().transcripts[CONVERSATION_ID];
      expect(transcript?.messages).toHaveLength(1);
      expect(transcript?.messages[0]).toMatchObject({
        status: 'failed',
        content: { text: 'fails' },
      });
    });
  });

  describe('resendFromMessage (chat-ux Phase 2 Task 4, audit #5)', () => {
    it('retries a failed turn: truncates the target user message and everything after it, then resends its own text', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const kept = message({
        id: 'kept',
        turnId: 'turn-0',
        ordinal: 1,
        content: { type: 'user', text: 'Earlier' },
      });
      const target = message({
        id: 'u1',
        turnId: 'turn-1',
        ordinal: 2,
        content: { type: 'user', text: 'Hello' },
      });
      const failedReply = message({
        id: 'a1',
        turnId: 'turn-1',
        ordinal: 3,
        role: 'assistant',
        status: 'failed',
        content: { type: 'assistant', events: [] },
      });
      store.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [CONVERSATION_ID]: {
            messages: [kept, target, failedReply],
            streaming: null,
          },
        },
      }));

      // fix I5: resolves `true` once the resend actually fired.
      await expect(store.getState().resendFromMessage(CONVERSATION_ID, 'u1')).resolves.toBe(true);

      const messages = store.getState().transcripts[CONVERSATION_ID]?.messages ?? [];
      // The failed turn (u1 + a1) is gone; the earlier turn survives; a
      // fresh optimistic message (same text) replaces it.
      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe(kept);
      expect(messages[1]).toMatchObject({ role: 'user', content: { type: 'user', text: 'Hello' } });
      expect(sockets[0].sent).toHaveLength(1);
      expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: 'Hello' });
    });

    it('sends editedText instead of the original when provided (edit & resend)', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const target = message({
        id: 'u1',
        turnId: 'turn-1',
        ordinal: 1,
        content: { type: 'user', text: 'Original text' },
      });
      store.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [CONVERSATION_ID]: { messages: [target], streaming: null },
        },
      }));

      await expect(
        store.getState().resendFromMessage(CONVERSATION_ID, 'u1', 'Edited text'),
      ).resolves.toBe(true);

      const messages = store.getState().transcripts[CONVERSATION_ID]?.messages ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ content: { type: 'user', text: 'Edited text' } });
      expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: 'Edited text' });
    });

    it('is a no-op for an id that is not a user message in the transcript', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const assistantOnly = message({
        id: 'a1',
        turnId: 'turn-1',
        ordinal: 1,
        role: 'assistant',
        content: { type: 'assistant', events: [] },
      });
      store.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [CONVERSATION_ID]: { messages: [assistantOnly], streaming: null },
        },
      }));

      // fix I5: resolves `false`, never throws, for either no-op shape.
      await expect(store.getState().resendFromMessage(CONVERSATION_ID, 'a1')).resolves.toBe(false);
      await expect(
        store.getState().resendFromMessage(CONVERSATION_ID, 'does-not-exist'),
      ).resolves.toBe(false);

      expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toEqual([assistantOnly]);
      expect(sockets[0].sent).toHaveLength(0);
    });

    it('throws and truncates nothing when not connected', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const target = message({
        id: 'u1',
        turnId: 'turn-1',
        ordinal: 1,
        content: { type: 'user', text: 'Hello' },
      });
      store.setState((state) => ({
        transcripts: {
          ...state.transcripts,
          [CONVERSATION_ID]: { messages: [target], streaming: null },
        },
      }));

      onCloses[0](RETRYABLE_ERROR_CLOSE);
      expect(store.getState().connection).toBe('reconnecting');

      await expect(store.getState().resendFromMessage(CONVERSATION_ID, 'u1')).rejects.toThrow();
      expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toEqual([target]);
    });

    it("is a no-op while a LATER turn is actively streaming — even when messageId names an earlier, already-failed message (regression: used to truncate the in-flight turn's own optimistic message and fire a second, orphaned send)", async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const failedEarlier = message({
        id: 'u1',
        turnId: 'turn-1',
        ordinal: 1,
        status: 'failed',
        content: { type: 'user', text: 'Earlier failed message' },
      });
      const inFlightUser = message({
        id: 'u2',
        turnId: 'turn-2',
        ordinal: 2,
        content: { type: 'user', text: 'Newer message, still streaming' },
      });
      const transcriptBefore = {
        messages: [failedEarlier, inFlightUser],
        streaming: { type: 'assistant' as const, events: [] },
        pending: {
          turnId: 'turn-2',
          conversationId: CONVERSATION_ID,
          assistantMessageId: 'assistant-2',
        },
      };
      store.setState((state) => ({
        transcripts: { ...state.transcripts, [CONVERSATION_ID]: transcriptBefore },
      }));

      // fix I5: resolves `false` — this is the exact "guarded, don't
      // silently discard the caller's edited text" case the fix exists for.
      await expect(store.getState().resendFromMessage(CONVERSATION_ID, 'u1')).resolves.toBe(false);

      expect(store.getState().transcripts[CONVERSATION_ID]).toEqual(transcriptBefore);
      expect(sockets[0].sent).toHaveLength(0);
    });

    it('is a no-op while a turn is merely pending (accepted but no event yet), not just while actively streaming', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const failedEarlier = message({
        id: 'u1',
        turnId: 'turn-1',
        ordinal: 1,
        status: 'failed',
        content: { type: 'user', text: 'Earlier failed message' },
      });
      const transcriptBefore = {
        messages: [failedEarlier],
        streaming: null,
        pending: {
          turnId: 'turn-2',
          conversationId: CONVERSATION_ID,
          assistantMessageId: 'assistant-2',
        },
      };
      store.setState((state) => ({
        transcripts: { ...state.transcripts, [CONVERSATION_ID]: transcriptBefore },
      }));

      await expect(store.getState().resendFromMessage(CONVERSATION_ID, 'u1')).resolves.toBe(false);

      expect(store.getState().transcripts[CONVERSATION_ID]).toEqual(transcriptBefore);
      expect(sockets[0].sent).toHaveLength(0);
    });
  });

  describe('frame handling', () => {
    it('reconciles the optimistic user message id and assembles the streaming assistant reply', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');
      const turnId = sockets[0].sent[0].id;

      const accepted: MobileWsServerFrame = {
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'real-user-msg-id',
        assistantMessageId: 'real-assistant-msg-id',
        revision: 2,
        seq: 1,
      };
      onFrames[0](accepted);

      const event: MobileWsServerFrame = {
        type: 'event',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        event: { type: 'text_delta', text: 'hi!' },
      };
      onFrames[0](event);

      const transcriptMidStream = store.getState().transcripts[CONVERSATION_ID];
      expect(transcriptMidStream?.messages.map((m) => m.id)).toEqual(['real-user-msg-id']);
      expect(transcriptMidStream?.streaming).toEqual({
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'hi!' }],
      });

      const done: MobileWsServerFrame = {
        type: 'done',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 3,
        outcome: 'completed',
      };
      onFrames[0](done);

      const finalTranscript = store.getState().transcripts[CONVERSATION_ID];
      expect(finalTranscript?.streaming).toBeNull();
      expect(finalTranscript?.messages.map((m) => m.id)).toEqual([
        'real-user-msg-id',
        'real-assistant-msg-id',
      ]);
    });

    it('marks the conversation interrupted on an error frame while leaving the transcript intact', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'real-user-msg-id',
        assistantMessageId: 'real-assistant-msg-id',
        revision: 2,
        seq: 1,
      });
      const beforeMessages = store.getState().transcripts[CONVERSATION_ID]?.messages;
      const beforeStreaming = store.getState().transcripts[CONVERSATION_ID]?.streaming;

      onFrames[0]({
        type: 'error',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        error: 'Conversation already has an active turn',
        code: 'conversation_busy',
        retryable: true,
      });

      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.status).toBe(
        'interrupted',
      );
      const transcript = store.getState().transcripts[CONVERSATION_ID];
      expect(transcript?.messages).toEqual(beforeMessages);
      expect(transcript?.streaming).toEqual(beforeStreaming);
      expect(transcript?.error).toMatchObject({
        message: 'Conversation already has an active turn',
        code: 'conversation_busy',
        retryable: true,
      });
    });

    it('re-fetches the conversation summary when a turn completes on a conversation whose title is still the default (chat-ux Phase 3 Task 1, audit #8)', async () => {
      const untitled = summary({ title: 'New Conversation', revision: 1 });
      const retitled = { ...untitled, title: 'Trip to Lisbon', revision: 2 };
      const { rest, getConversation } = fakeRest({
        conversationPage: { items: [untitled], nextCursor: null },
        getConversationImpl: async () => retitled,
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hi');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'u1',
        assistantMessageId: 'a1',
        revision: 1,
        seq: 1,
      });
      onFrames[0]({
        type: 'done',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        outcome: 'completed',
      });

      await vi.waitFor(() => expect(getConversation).toHaveBeenCalledWith(CONVERSATION_ID));
      await vi.waitFor(() =>
        expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
          'Trip to Lisbon',
        ),
      );
    });

    // Chat UX Phase 4 Task 6 (re-review parked minor 3): the post-turn
    // summary refresh could land AFTER the user had already optimistically
    // renamed the conversation, momentarily overwriting their new title with
    // the gateway's (older) one until the rename's PATCH response put it back.
    // The refresh is best-effort; a title the user changed in the meantime
    // must win.
    it('does not overwrite an optimistic rename made while the post-turn summary refresh was in flight', async () => {
      const untitled = summary({ title: 'New Conversation', revision: 1 });
      let resolveRefresh: (value: ConversationSummary) => void = () => {};
      const { rest, getConversation } = fakeRest({
        conversationPage: { items: [untitled], nextCursor: null },
        getConversationImpl: () =>
          new Promise<ConversationSummary>((resolve) => {
            resolveRefresh = resolve;
          }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hi');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'u1',
        assistantMessageId: 'a1',
        revision: 1,
        seq: 1,
      });
      onFrames[0]({
        type: 'done',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        outcome: 'completed',
      });
      await vi.waitFor(() => expect(getConversation).toHaveBeenCalledWith(CONVERSATION_ID));

      await store.getState().renameConversation(CONVERSATION_ID, 'Lisbon planning');
      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
        'Lisbon planning',
      );

      // The refresh resolves late, still carrying the pre-rename title.
      resolveRefresh({ ...untitled, revision: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
        'Lisbon planning',
      );
    });

    it('final-review fix C1b: still re-fetches on done when the conversation already has a non-default title (also refreshes lastMessagePreview/revision, not just the auto-title case)', async () => {
      const titled = summary({ title: 'Already named', revision: 1, lastMessagePreview: null });
      const refreshed = { ...titled, revision: 2, lastMessagePreview: 'hi' };
      const { rest, getConversation } = fakeRest({
        conversationPage: { items: [titled], nextCursor: null },
        getConversationImpl: async () => refreshed,
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hi');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'u1',
        assistantMessageId: 'a1',
        revision: 1,
        seq: 1,
      });
      onFrames[0]({
        type: 'done',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        outcome: 'completed',
      });

      await vi.waitFor(() => expect(getConversation).toHaveBeenCalledWith(CONVERSATION_ID));
      await vi.waitFor(() =>
        expect(
          store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.lastMessagePreview,
        ).toBe('hi'),
      );
    });

    it('final-review fix C1a: applies the accepted frame\'s fresh revision to the summary immediately, before "done" ever fires', async () => {
      const { rest } = fakeRest({
        conversationPage: { items: [summary({ revision: 1 })], nextCursor: null },
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hi');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'u1',
        assistantMessageId: 'a1',
        revision: 7,
        seq: 1,
      });

      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.revision).toBe(
        7,
      );
    });
  });

  describe('renameConversation (chat-ux Phase 3 Task 1, audit #8)', () => {
    it('optimistically updates the title before REST resolves, then reconciles with the server response', async () => {
      const original = summary({ title: 'New Conversation', revision: 1 });
      const { rest, patchConversation } = fakeRest({
        conversationPage: { items: [original], nextCursor: null },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const renaming = store.getState().renameConversation(CONVERSATION_ID, 'Renamed thread');
      // The optimistic write happens synchronously, before the REST round-trip
      // resolves — visible immediately, not just after `renaming` settles.
      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
        'Renamed thread',
      );

      await renaming;
      expect(patchConversation).toHaveBeenCalledWith(
        CONVERSATION_ID,
        { title: 'Renamed thread' },
        1,
      );
      const updated = store.getState().conversations.find((c) => c.id === CONVERSATION_ID);
      expect(updated?.title).toBe('Renamed thread');
      expect(updated?.revision).toBe(2);
    });

    it('keeps the complete authoritative server summary after a v1 rename', async () => {
      const original = summary({
        title: 'Original',
        revision: 1,
        status: 'idle',
        projectId: 'project-before',
        lastSeq: 2,
        lastMessagePreview: 'before',
      });
      const updated = summary({
        title: 'Renamed',
        revision: 4,
        status: 'running',
        activeTurnId: 'server-run',
        projectId: 'project-after',
        lastSeq: 9,
        lastMessagePreview: 'after',
      });
      const { rest } = fakeRest({
        conversationPage: { items: [original], nextCursor: null },
        patchConversationImpl: async () => updated,
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await store.getState().renameConversation(CONVERSATION_ID, 'Renamed');

      expect(store.getState().conversations[0]).toEqual(updated);
    });

    it('rolls back the optimistic title on a REST failure and rethrows', async () => {
      const original = summary({ title: 'Original title', revision: 1 });
      const { rest } = fakeRest({
        conversationPage: { items: [original], nextCursor: null },
        patchConversationImpl: async () => {
          throw new Error('gateway rejected the rename');
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await expect(
        store.getState().renameConversation(CONVERSATION_ID, 'Attempted rename'),
      ).rejects.toThrow('gateway rejected the rename');
      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
        'Original title',
      );
    });

    it('rolls overlapping failed renames back to the last authoritative title', async () => {
      let rejectFirst!: (error: Error) => void;
      let rejectSecond!: (error: Error) => void;
      const firstResponse = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectFirst = reject;
      });
      const secondResponse = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectSecond = reject;
      });
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary({ title: 'Authoritative title', revision: 1 })],
          nextCursor: null,
        },
        patchConversationImpl: async (_conversationId, patch) =>
          (patch as { title: string }).title === 'First' ? firstResponse : secondResponse,
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const first = store.getState().renameConversation(CONVERSATION_ID, 'First');
      const second = store.getState().renameConversation(CONVERSATION_ID, 'Second');
      rejectSecond(new Error('second failed'));
      await expect(second).rejects.toThrow('second failed');
      expect(store.getState().conversations[0].title).toBe('Authoritative title');

      rejectFirst(new Error('first failed'));
      await expect(first).rejects.toThrow('first failed');
      expect(store.getState().conversations[0].title).toBe('Authoritative title');
    });

    it('reconciles an older successful rename after a newer overlapping attempt fails', async () => {
      let resolveFirst!: (summary: ConversationSummary) => void;
      let rejectSecond!: (error: Error) => void;
      const firstResponse = new Promise<ConversationSummary>((resolve) => {
        resolveFirst = resolve;
      });
      const secondResponse = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectSecond = reject;
      });
      const original = summary({ title: 'Original', revision: 1 });
      const { rest } = fakeRest({
        conversationPage: { items: [original], nextCursor: null },
        patchConversationImpl: async (_conversationId, patch) =>
          (patch as { title: string }).title === 'First' ? firstResponse : secondResponse,
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const first = store.getState().renameConversation(CONVERSATION_ID, 'First');
      const second = store.getState().renameConversation(CONVERSATION_ID, 'Second');
      rejectSecond(new Error('second rename failed'));
      await expect(second).rejects.toThrow('second rename failed');
      expect(store.getState().conversations[0]).toEqual(original);

      const firstCommitted = summary({ title: 'First', revision: 2 });
      resolveFirst(firstCommitted);
      await first;
      expect(store.getState().conversations[0]).toEqual(firstCommitted);
    });

    it('is a no-op for an unknown conversation id', async () => {
      const { rest, patchConversation } = fakeRest({
        conversationPage: { items: [], nextCursor: null },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await store.getState().renameConversation('missing-conv', 'x');
      expect(patchConversation).not.toHaveBeenCalled();
    });

    it('on a 401, rolls back the optimistic title and transitions to unauthorized instead of rethrowing', async () => {
      const original = summary({ title: 'Original title', revision: 1 });
      const { rest } = fakeRest({
        conversationPage: { items: [original], nextCursor: null },
        patchConversationImpl: async () => {
          throw new MobileApiError(401, undefined);
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await store.getState().renameConversation(CONVERSATION_ID, 'Attempted rename');
      expect(store.getState().connection).toBe('unauthorized');
      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
        'Original title',
      );
    });

    describe('final-review fix C1c: revision_conflict retry-once', () => {
      it('a stale revision refetches the summary and retries once, succeeding', async () => {
        const original = summary({ title: 'Original title', revision: 1 });
        let calls = 0;
        const { rest, getConversation } = fakeRest({
          conversationPage: { items: [original], nextCursor: null },
          patchConversationImpl: async (conversationId, patch, revision) => {
            calls += 1;
            if (calls === 1) {
              expect(revision).toBe(1);
              throw new MobileApiError(409, 'revision_conflict');
            }
            expect(revision).toBe(5);
            return summary({ id: conversationId, ...(patch as object), revision: 6 });
          },
          getConversationImpl: async () => summary({ revision: 5, title: 'Original title' }),
        });
        const { factory } = scriptedSocketFactory();
        const store = createTestStore({ rest, socketFactory: factory });
        await store.getState().loadConversations();

        await store.getState().renameConversation(CONVERSATION_ID, 'Renamed after conflict');

        expect(getConversation).toHaveBeenCalledWith(CONVERSATION_ID);
        expect(calls).toBe(2);
        const updated = store.getState().conversations.find((c) => c.id === CONVERSATION_ID);
        expect(updated?.title).toBe('Renamed after conflict');
        expect(updated?.revision).toBe(6);
      });

      it('a double revision_conflict (still stale after the retry) rolls back and surfaces the error — no reload-required dead end', async () => {
        const original = summary({ title: 'Original title', revision: 1 });
        const fresh = summary({
          title: 'Remote title',
          revision: 5,
          status: 'running',
          activeTurnId: 'remote-run',
          lastSeq: 8,
          lastMessagePreview: 'remote preview',
        });
        const { rest, getConversation } = fakeRest({
          conversationPage: { items: [original], nextCursor: null },
          patchConversationImpl: async () => {
            throw new MobileApiError(409, 'revision_conflict');
          },
          getConversationImpl: async () => fresh,
        });
        const { factory } = scriptedSocketFactory();
        const store = createTestStore({ rest, socketFactory: factory });
        await store.getState().loadConversations();

        await expect(
          store.getState().renameConversation(CONVERSATION_ID, 'Renamed after conflict'),
        ).rejects.toBeInstanceOf(MobileApiError);

        expect(getConversation).toHaveBeenCalledTimes(1); // refetched exactly once, not looped
        expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)).toEqual(fresh);
      });
    });
  });

  describe('deleteConversation (chat-ux Phase 3 Task 1, audit #8)', () => {
    it('optimistically removes the conversation before REST resolves, then stays removed', async () => {
      const target = summary({ id: 'conv-1', revision: 1 });
      const other = summary({ id: 'conv-2', revision: 1 });
      const { rest, deleteConversation } = fakeRest({
        conversationPage: { items: [target, other], nextCursor: null },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const deleting = store.getState().deleteConversation('conv-1');
      expect(store.getState().conversations.map((c) => c.id)).toEqual(['conv-2']);

      await deleting;
      expect(deleteConversation).toHaveBeenCalledWith('conv-1', 1);
      expect(store.getState().conversations.map((c) => c.id)).toEqual(['conv-2']);
    });

    it('rolls back on a REST failure and rethrows', async () => {
      const target = summary({ id: 'conv-1', revision: 1 });
      const { rest } = fakeRest({
        conversationPage: { items: [target], nextCursor: null },
        deleteConversationImpl: async () => {
          throw new Error('gateway rejected the delete');
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await expect(store.getState().deleteConversation('conv-1')).rejects.toThrow(
        'gateway rejected the delete',
      );
      expect(store.getState().conversations.map((c) => c.id)).toEqual(['conv-1']);
    });

    it('is a no-op for an unknown conversation id', async () => {
      const { rest, deleteConversation } = fakeRest({
        conversationPage: { items: [], nextCursor: null },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await store.getState().deleteConversation('missing-conv');
      expect(deleteConversation).not.toHaveBeenCalled();
    });

    it('closes the live socket and clears connection back to idle when deleting the currently open conversation', async () => {
      const target = summary({ id: CONVERSATION_ID, revision: 1 });
      const { rest } = fakeRest({ conversationPage: { items: [target], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);
      expect(store.getState().connection).toBe('connected');

      await store.getState().deleteConversation(CONVERSATION_ID);

      expect(sockets[0].closed).toBe(true);
      expect(store.getState().connection).toBe('idle');
    });

    it('leaves the live socket alone when deleting a conversation other than the currently open one', async () => {
      const open = summary({ id: CONVERSATION_ID, revision: 1 });
      const other = summary({ id: 'conv-other', revision: 1 });
      const { rest, deleteConversation } = fakeRest({
        conversationPage: { items: [open, other], nextCursor: null },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().deleteConversation('conv-other');

      expect(deleteConversation).toHaveBeenCalledWith('conv-other', 1);
      expect(sockets[0].closed).toBe(false);
      expect(store.getState().connection).toBe('connected');
    });

    it('on a 401, rolls back and transitions to unauthorized instead of rethrowing', async () => {
      const target = summary({ id: 'conv-1', revision: 1 });
      const { rest } = fakeRest({
        conversationPage: { items: [target], nextCursor: null },
        deleteConversationImpl: async () => {
          throw new MobileApiError(401, undefined);
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await store.getState().deleteConversation('conv-1');
      expect(store.getState().connection).toBe('unauthorized');
      expect(store.getState().conversations.map((c) => c.id)).toEqual(['conv-1']);
    });

    describe('final-review fix C1c: revision_conflict retry-once', () => {
      it('a stale revision refetches the summary and retries once, succeeding', async () => {
        const target = summary({ id: 'conv-1', revision: 1 });
        let calls = 0;
        const { rest, getConversation, deleteConversation } = fakeRest({
          conversationPage: { items: [target], nextCursor: null },
          deleteConversationImpl: async (conversationId, revision) => {
            calls += 1;
            if (calls === 1) {
              expect(revision).toBe(1);
              throw new MobileApiError(409, 'revision_conflict');
            }
            expect(revision).toBe(5);
            return summary({ id: conversationId, status: 'deleted', revision: 6 });
          },
          getConversationImpl: async () => summary({ id: 'conv-1', revision: 5 }),
        });
        const { factory } = scriptedSocketFactory();
        const store = createTestStore({ rest, socketFactory: factory });
        await store.getState().loadConversations();

        await store.getState().deleteConversation('conv-1');

        expect(getConversation).toHaveBeenCalledWith('conv-1');
        expect(deleteConversation).toHaveBeenCalledTimes(2);
        expect(store.getState().conversations.map((c) => c.id)).toEqual([]);
      });

      it('a double revision_conflict (still stale after the retry) rolls back the row and surfaces the error — no reload-required dead end', async () => {
        const target = summary({ id: 'conv-1', revision: 1 });
        const { rest, getConversation } = fakeRest({
          conversationPage: { items: [target], nextCursor: null },
          deleteConversationImpl: async () => {
            throw new MobileApiError(409, 'revision_conflict');
          },
          getConversationImpl: async () => summary({ id: 'conv-1', revision: 5 }),
        });
        const { factory } = scriptedSocketFactory();
        const store = createTestStore({ rest, socketFactory: factory });
        await store.getState().loadConversations();

        await expect(store.getState().deleteConversation('conv-1')).rejects.toBeInstanceOf(
          MobileApiError,
        );

        expect(getConversation).toHaveBeenCalledTimes(1); // refetched exactly once, not looped
        expect(store.getState().conversations.map((c) => c.id)).toEqual(['conv-1']);
      });

      it('restores the freshly fetched summary when the conflict retry then fails', async () => {
        const target = summary({
          id: 'conv-1',
          revision: 1,
          status: 'idle',
          lastMessagePreview: 'stale',
        });
        const fresh = summary({
          id: 'conv-1',
          revision: 5,
          status: 'running',
          activeTurnId: 'newer-run',
          lastMessagePreview: 'fresh',
        });
        let calls = 0;
        const { rest } = fakeRest({
          conversationPage: { items: [target], nextCursor: null },
          deleteConversationImpl: async () => {
            calls += 1;
            if (calls === 1) throw new MobileApiError(409, 'revision_conflict');
            throw new Error('retry failed');
          },
          getConversationImpl: async () => fresh,
        });
        const { factory } = scriptedSocketFactory();
        const store = createTestStore({ rest, socketFactory: factory });
        await store.getState().loadConversations();

        await expect(store.getState().deleteConversation('conv-1')).rejects.toThrow('retry failed');

        expect(store.getState().conversations[0]).toEqual(fresh);
      });
    });
  });

  describe('cancelTurn (chat-ux Phase 2 Task 2, audit #3)', () => {
    it('sends a cancel frame keyed on the accepted turn id', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'real-user-msg-id',
        assistantMessageId: 'real-assistant-msg-id',
        revision: 2,
        seq: 1,
      });

      store.getState().cancelTurn(CONVERSATION_ID);

      expect(sockets[0].sent).toContainEqual({ type: 'cancel', id: turnId });
    });

    it('is a no-op before any turn has been accepted (no pending turnId yet)', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().cancelTurn(CONVERSATION_ID);

      expect(sockets[0].sent).toHaveLength(0);
    });

    it('is a no-op for a conversation id other than the one the live socket is attached to', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'real-user-msg-id',
        assistantMessageId: 'real-assistant-msg-id',
        revision: 2,
        seq: 1,
      });

      const sentBefore = sockets[0].sent.length;
      store.getState().cancelTurn('some-other-conversation');

      expect(sockets[0].sent).toHaveLength(sentBefore);
      expect(sockets[0].sent.some((frame) => frame.type === 'cancel')).toBe(false);
    });

    it('logs and swallows a cancel send failure instead of throwing (stop button stays until a real done/error frame lands)', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');
      const turnId = sockets[0].sent[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'real-user-msg-id',
        assistantMessageId: 'real-assistant-msg-id',
        revision: 2,
        seq: 1,
      });

      socket.sendShouldThrow = true;
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => store.getState().cancelTurn(CONVERSATION_ID)).not.toThrow();

      expect(consoleError).toHaveBeenCalled();
      // The turn is still tracked as pending — nothing here finalized it;
      // only a subsequent `done`/`error` frame does that (see `assemble.ts`).
      expect(store.getState().transcripts[CONVERSATION_ID]?.pending?.turnId).toBe(turnId);
      consoleError.mockRestore();
    });
  });

  describe('reconnect', () => {
    it("resets lastSeq on openConversation, so a switch-then-failed-replay reconnect resumes the NEW conversation at 0, never the previous one's cursor (regression: lastSeq is a single per-store variable, only ever set on successful replay)", async () => {
      const CONV_A = 'conv-a';
      const CONV_B = 'conv-b';
      const rest = {
        listConversations: vi.fn(async () => ({
          items: [
            summary({ id: CONV_A, agentId: 'agent-a' }),
            summary({ id: CONV_B, agentId: 'agent-b' }),
          ],
          nextCursor: null,
        })),
        getMessages: vi.fn(async (conversationId: string) => {
          if (conversationId === CONV_A) {
            return { items: [], nextCursor: null, throughSeq: 42 };
          }
          throw new TypeError('fetch failed'); // conv-b's own replay always fails (non-auth)
        }),
        identity: vi.fn(async () => ({ gatewayId: 'gw-1', publicKey: 'pk-stub' })),
      } as unknown as MobileRestClient;
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      // Conversation A replays successfully with a real cursor (42) and connects.
      await openAndConnect(store, sockets, CONV_A);
      expect(sockets).toHaveLength(1);

      // Switching to conversation B: its own initial replay fails (non-auth),
      // so openConversation() takes the 'reconnecting' + scheduleReconnect()
      // path added for the earlier fix — never touching conv-b's transcript
      // with conv-a's lastSeq.
      await store.getState().openConversation(CONV_B);
      expect(store.getState().connection).toBe('reconnecting');
      expect(sockets).toHaveLength(1); // no socket attempted for the failed replay itself

      // The armed reconnect resumes conv-b, not conv-a.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));

      expect(sockets[1].sent).toHaveLength(1);
      expect(sockets[1].sent[0]).toMatchObject({
        type: 'resume',
        conversationId: CONV_B,
        agentId: 'agent-b',
        sinceSeq: 0, // NOT 42 — conv-a's cursor must never leak into conv-b's resume
      });
    });

    it('resumes from lastSeq via a typed resume frame (chat-resume.jsonl) instead of refetching history, and finalizes the interrupted turn through replay', async () => {
      // Real fixture: contracts/mobile/v1/fixtures/chat-resume.jsonl. Line 0
      // is the client `resume` frame this store must send, verbatim, on
      // reconnect. Lines 1-3 replay the rest of the turn that was mid-stream
      // when the connection dropped (an `event`, `event`, `done`).
      const fixtureLines = readJsonl<Record<string, unknown>>('chat-resume.jsonl');
      const expectedResumeFrame = fixtureLines[0] as unknown as MobileWsClientFrame;
      const replayFrames = fixtureLines.slice(1, 4) as unknown as MobileWsServerFrame[];
      const turn2Frames = fixtureLines.slice(4, 6) as unknown as MobileWsServerFrame[];

      const FIXTURE_CONVERSATION_ID = '018f0f4a-5c42-7a8b-9c01-1234567890ab';
      const FIXTURE_TURN_ID = '018f0f4a-5c42-7a8b-9c01-2234567890ab';
      const FIXTURE_ASSISTANT_MSG_ID = '018f0f4a-5c42-7a8b-9c01-4234567890ab';

      const { rest, getMessages } = fakeRest({
        conversationPage: {
          items: [summary({ id: FIXTURE_CONVERSATION_ID, agentId: 'agent-01' })],
          nextCursor: null,
        },
        messagePages: [{ items: [], nextCursor: null, throughSeq: 0 }],
      });
      const { factory, sockets, onFrames, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await openAndConnect(store, sockets, FIXTURE_CONVERSATION_ID);

      // Pre-drop: the turn was accepted and one event streamed (seq 1, 2) —
      // matching the fixture's `sinceSeq: 2`.
      onFrames[0]({
        type: 'accepted',
        id: FIXTURE_TURN_ID,
        conversationId: FIXTURE_CONVERSATION_ID,
        userMessageId: '018f0f4a-5c42-7a8b-9c01-3234567890ab',
        assistantMessageId: FIXTURE_ASSISTANT_MSG_ID,
        revision: 2,
        seq: 1,
      });
      onFrames[0]({
        type: 'event',
        id: FIXTURE_TURN_ID,
        conversationId: FIXTURE_CONVERSATION_ID,
        seq: 2,
        event: { type: 'text_delta', text: 'partial ' },
      });

      // The connection drops mid-stream.
      onCloses[0](RETRYABLE_ERROR_CLOSE);
      expect(store.getState().connection).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));

      // CRITICAL-1: a typed `resume` frame — matching the real fixture
      // exactly — not a REST refetch.
      expect(sockets[1].sent).toEqual([expectedResumeFrame]);
      expect(getMessages).toHaveBeenCalledTimes(1); // only the initial replay — never again on reconnect

      for (const frame of replayFrames) onFrames[1](frame);

      // CRITICAL-2: streaming cleared, exactly one finalized assistant message.
      const afterReplay = store.getState().transcripts[FIXTURE_CONVERSATION_ID];
      expect(afterReplay?.streaming).toBeNull();
      const assistantMessages = afterReplay?.messages.filter((m) => m.role === 'assistant') ?? [];
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]).toMatchObject({
        id: FIXTURE_ASSISTANT_MSG_ID,
        status: 'completed',
        content: {
          type: 'assistant',
          events: [
            { type: 'text_delta', text: 'partial ' },
            expect.objectContaining({ type: 'question' }),
            expect.objectContaining({ type: 'response' }),
          ],
        },
      });

      // The fixture continues with an unrelated second turn (accepted ->
      // cancelled) — confirms replay doesn't confuse it with the first.
      for (const frame of turn2Frames) onFrames[1](frame);
      const final = store.getState().transcripts[FIXTURE_CONVERSATION_ID];
      const finalAssistantMessages = final?.messages.filter((m) => m.role === 'assistant') ?? [];
      expect(finalAssistantMessages).toHaveLength(2);
      expect(finalAssistantMessages[1]).toMatchObject({ status: 'cancelled' });
      expect(final?.streaming).toBeNull();
    });

    it('keeps retrying with a fresh socket-factory call on each failed attempt', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].failToOpen();

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * RECONNECT_FACTOR);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3));
      expect(store.getState().connection).toBe('reconnecting');
    });

    it('gives up and transitions to offline after the configured attempt cap', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({
        rest,
        socketFactory: factory,
        reconnect: { maxAttempts: 2 },
      });

      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE); // attempt 1 scheduled
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].failToOpen(); // attempt 2 scheduled

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * RECONNECT_FACTOR);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3));
      sockets[2].failToOpen(); // cap reached — no attempt 3

      await vi.waitFor(() => expect(store.getState().connection).toBe('offline'));

      // No further attempts even after waiting well past another backoff window.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * RECONNECT_FACTOR ** 3);
      expect(factory).toHaveBeenCalledTimes(3);

      // A fresh openConversation() call restarts the cycle (manual retry).
      await openAndConnect(store, sockets, CONVERSATION_ID);
      expect(store.getState().connection).toBe('connected');
    });

    it('closing the socket to switch conversations does not disable reconnect for a later, genuine drop', async () => {
      const rest = {
        listConversations: vi.fn(async () => ({
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-02' })],
          nextCursor: null,
        })),
        getMessages: vi.fn(async () => ({ items: [], nextCursor: null, throughSeq: 0 })),
      } as unknown as MobileRestClient;
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await openAndConnect(store, sockets, CONVERSATION_ID);
      // Switching conversations closes the first socket without a global flag.
      await openAndConnect(store, sockets, 'conv-2');
      expect(sockets[0].closed).toBe(true);

      // A late close from the now-detached first socket must not affect
      // the (unrelated, still-live) current connection.
      onCloses[0](RETRYABLE_CLOSED_CLOSE);
      expect(store.getState().connection).toBe('connected');
      expect(factory).toHaveBeenCalledTimes(2); // no spurious reconnect attempt

      // A genuine drop of the *current* socket still reconnects normally.
      onCloses[1](RETRYABLE_ERROR_CLOSE);
      expect(store.getState().connection).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3));
    });
  });

  describe('openConversation lifecycle races', () => {
    it('attaches no socket when dispose() lands during the replay round-trip', async () => {
      let releaseReplay!: (page: ConversationMessagePage) => void;
      const { rest } = fakeRest({
        getMessagesImpl: () =>
          new Promise<ConversationMessagePage>((resolve) => {
            releaseReplay = resolve;
          }),
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      store.getState().dispose();
      releaseReplay({ items: [], nextCursor: null, throughSeq: 0 });
      await opening;

      // Without the post-await disposed check this opened a socket that the
      // already-completed dispose() could never close — a leaked connection.
      expect(factory).not.toHaveBeenCalled();
    });

    it('closes the socket when dispose() lands while connect() is in flight', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      store.getState().dispose();
      sockets[0].open();
      await opening;

      expect(sockets[0].closed).toBe(true);
      expect(store.getState().connection).not.toBe('connected');
    });

    it("reports 'reconnecting' and retries when the initial connect fails, instead of rejecting", async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0].failToOpen();

      // Resolves rather than rejecting: the only caller is a React effect.
      await expect(opening).resolves.toBeUndefined();
      expect(sockets[0].closed).toBe(true);
      expect(store.getState().connection).toBe('reconnecting');

      // And it retries on the usual backoff rather than giving up silently.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    });
  });

  describe('auth failures (design doc: never a silent retry loop on 401)', () => {
    it("a 401 during openConversation's initial replay goes straight to 'unauthorized', with no socket ever attempted", async () => {
      const { rest, getMessages } = fakeRest({
        getMessagesImpl: async () => {
          throw new MobileApiError(401, undefined);
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await store.getState().openConversation(CONVERSATION_ID); // resolves — never rethrows an auth error

      expect(store.getState().connection).toBe('unauthorized');
      expect(getMessages).toHaveBeenCalledTimes(1);
      expect(factory).not.toHaveBeenCalled(); // no socket was ever attempted

      // No reconnect timer was armed either — waiting past every backoff
      // window confirms nothing fires afterwards.
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 10);
      expect(factory).not.toHaveBeenCalled();
      expect(store.getState().connection).toBe('unauthorized');
    });

    it("a relay-shaped 401 (plain text, no code) still reaches 'unauthorized'", async () => {
      // The relay rejects a revoked pairing credential before the gateway ever
      // sees the request, so the body is plain text and `code` is undefined —
      // only the status distinguishes it. It must be just as terminal as the
      // gateway's structured 401: this credential is dead either way.
      const { rest, listConversations } = fakeRest({
        listConversationsImpl: async () => {
          throw new MobileApiError(401, undefined);
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await expect(store.getState().loadConversations()).resolves.toBeUndefined();

      expect(listConversations).toHaveBeenCalledTimes(1);
      expect(store.getState().connection).toBe('unauthorized');
      // Terminal: no reconnect is ever armed out of it.
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 10);
      expect(factory).not.toHaveBeenCalled();
      expect(store.getState().connection).toBe('unauthorized');
    });

    it("a 401 from loadConversations() goes to 'unauthorized' without throwing", async () => {
      const { rest, listConversations } = fakeRest({
        listConversationsImpl: async () => {
          throw new MobileApiError(401, 'unauthorized');
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await expect(store.getState().loadConversations()).resolves.toBeUndefined();

      expect(listConversations).toHaveBeenCalledTimes(1);
      expect(store.getState().connection).toBe('unauthorized');
    });

    it('a non-401 error from loadConversations() still propagates (not swallowed into a connection state)', async () => {
      const { rest } = fakeRest({
        listConversationsImpl: async () => {
          throw new Error('network blip');
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      await expect(store.getState().loadConversations()).rejects.toThrow('network blip');
      expect(store.getState().connection).toBe('idle'); // untouched initial value, not reinterpreted
    });

    it("a 401 from resolveAgentId's listConversations fallback during an in-flight reconnect goes straight to 'unauthorized' (no further scheduleReconnect)", async () => {
      // `openConversation()` never itself calls `listConversations` — only
      // `attemptReconnect`'s `resolveAgentId` fallback does, since
      // `conversations` is otherwise still empty at this point (no prior
      // `loadConversations()` call) — so this is the call the 401 lands on.
      const rest = {
        listConversations: vi.fn(async () => {
          throw new MobileApiError(401, undefined);
        }),
        getMessages: vi.fn(async () => ({ items: [], nextCursor: null, throughSeq: 0 })),
        identity: vi.fn(async () => ({ gatewayId: 'gw-1', publicKey: 'pk' })),
      } as unknown as MobileRestClient;
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE); // schedules reconnect attempt 1
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].open(); // connect() succeeds; resolveAgentId's listConversations 401s next

      await vi.waitFor(() => expect(store.getState().connection).toBe('unauthorized'));
      expect(sockets[1].closed).toBe(true);

      // No further reconnect attempt — well past every backoff window.
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 10);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(store.getState().connection).toBe('unauthorized');
    });

    it("once reconnect attempts exhaust, a 401 from the identity() probe means the credential was revoked — 'unauthorized', not 'offline'", async () => {
      const { rest } = fakeRest({
        identityImpl: async () => {
          throw new MobileApiError(401, undefined);
        },
      });
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({
        rest,
        socketFactory: factory,
        reconnect: { maxAttempts: 1 },
      });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE); // attempt 1 scheduled
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].failToOpen(); // cap reached (maxAttempts: 1) — probe fires

      await vi.waitFor(() => expect(store.getState().connection).toBe('unauthorized'));

      // No further reconnect attempts after landing on 'unauthorized'.
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 10);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(store.getState().connection).toBe('unauthorized');
    });

    it("once reconnect attempts exhaust, a genuine network error from the identity() probe still lands on 'offline' (not misclassified as unauthorized)", async () => {
      const { rest } = fakeRest({
        identityImpl: async () => {
          throw new TypeError('fetch failed'); // a plain network error, not MobileApiError
        },
      });
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({
        rest,
        socketFactory: factory,
        reconnect: { maxAttempts: 1 },
      });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE); // attempt 1 scheduled
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].failToOpen(); // cap reached — probe fires and also fails (network partition)

      await vi.waitFor(() => expect(store.getState().connection).toBe('offline'));
    });
  });

  describe('dispose', () => {
    it('closes the live socket and sets connection to offline', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().dispose();

      expect(sockets[0].closed).toBe(true);
      expect(store.getState().connection).toBe('offline');
    });

    it('cancels a pending reconnect timer so a dropped connection never comes back on its own', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE); // schedules a reconnect attempt
      expect(store.getState().connection).toBe('reconnecting');

      store.getState().dispose();
      expect(store.getState().connection).toBe('offline');

      // The reconnect timer that was pending at dispose time must not fire.
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * RECONNECT_FACTOR ** 3);
      expect(factory).toHaveBeenCalledTimes(1); // no second (reconnect) socket was ever created
      expect(store.getState().connection).toBe('offline');
    });

    it('discards a reconnect attempt already in flight when dispose runs mid-connect', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2)); // reconnect socket created, connect() pending

      store.getState().dispose();
      sockets[1].open(); // the in-flight connect() now resolves, after dispose

      await vi.waitFor(() => expect(sockets[1].closed).toBe(true));
      expect(store.getState().connection).toBe('offline'); // never flipped back to 'connected'
    });

    it('is idempotent and safe to call with no live socket', async () => {
      const { rest } = fakeRest({});
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });

      expect(() => store.getState().dispose()).not.toThrow();
      expect(() => store.getState().dispose()).not.toThrow();
      expect(store.getState().connection).toBe('offline');
    });

    it('is reusable: a subsequent openConversation() clears the disposed flag and reconnects normally', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().dispose();
      expect(store.getState().connection).toBe('offline');

      await openAndConnect(store, sockets, CONVERSATION_ID);
      expect(store.getState().connection).toBe('connected');
    });
  });

  describe('protocol 2 conversation state', () => {
    it('installs bootstrap atomically, reduces replay before subscribe ack, and connects only after the matching ack', async () => {
      const bootstrap = v2Bootstrap({
        conversation: v2Summary({ v2LastSeq: 4 }),
        v2ThroughSeq: 4,
      });
      const { rest } = fakeRest({ bootstrapImpl: async () => bootstrap });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      expect(store.getState().protocol).toEqual(V2_PROTOCOL);
      expect(store.getState().v2Transcripts[CONVERSATION_ID]?.lastAppliedV2Seq).toBe(4);

      scripted.sockets[0].open();
      await vi.waitFor(() => expect(scripted.sockets[0].sent).toHaveLength(1));
      const subscription = scripted.sockets[0].sent[0] as Extract<
        MobileV2WsClientFrame,
        { type: 'subscribe_conversation' }
      >;
      expect(subscription).toMatchObject({
        type: 'subscribe_conversation',
        conversationId: CONVERSATION_ID,
        sinceV2Seq: 4,
      });
      expect(store.getState().connection).not.toBe('connected');

      scripted.onFrames[0](
        inputFrame('input_accepted', 5, pendingInput(), { id: 'remote-command' }),
      );
      scripted.onFrames[0]({
        type: 'conversation_subscribed',
        id: 'wrong-subscription',
        conversationId: CONVERSATION_ID,
        v2ThroughSeq: 5,
      });
      expect(store.getState().connection).not.toBe('connected');
      expect(store.getState().v2Transcripts[CONVERSATION_ID]?.inputs['input-1']).toBeDefined();

      scripted.onFrames[0]({
        type: 'conversation_subscribed',
        id: subscription.id,
        conversationId: CONVERSATION_ID,
        v2ThroughSeq: 5,
      });
      await opening;
      expect(store.getState().connection).toBe('connected');
      expect(store.getState().v2Transcripts[CONVERSATION_ID]?.lastAppliedV2Seq).toBe(5);
    });

    it('settles a rejected v2 subscription and enters the reconnect backoff', async () => {
      const { rest } = fakeRest({ bootstrapImpl: async () => v2Bootstrap() });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() => expect(scripted.sockets[0].sent).toHaveLength(1));
      const subscription = scripted.sockets[0].sent[0];
      if (subscription.type !== 'subscribe_conversation') {
        throw new Error('expected subscribe command');
      }

      scripted.onFrames[0]({
        type: 'command_rejected',
        id: subscription.id,
        conversationId: CONVERSATION_ID,
        code: 'validation_failed',
        error: 'subscription rejected',
        retryable: true,
      });

      await opening;
      expect(scripted.sockets[0].closed).toBe(true);
      expect(store.getState().connection).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(scripted.factory).toHaveBeenCalledTimes(2));
    });

    it('does not let a stale initial connect failure reject the next conversation subscription', async () => {
      const { rest } = fakeRest({
        bootstrapImpl: async (conversationId) =>
          v2Bootstrap({ conversation: v2Summary({ id: conversationId }) }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const openingA = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));

      const openingB = store.getState().openConversation('conv-b');
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[1].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );

      scripted.sockets[0].failToOpen();
      await openingA;
      acknowledgeSubscription(scripted, 1, 'conv-b');
      await openingB;

      expect(store.getState().connection).toBe('connected');
      expect(scripted.sockets[1].closed).toBe(false);
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
      expect(scripted.factory).toHaveBeenCalledTimes(2);
    });

    it('does not expose the next v2 conversation as connected while its bootstrap is pending', async () => {
      let resolveBootstrapB!: (bootstrap: MobileV2ConversationBootstrap) => void;
      const bootstrapB = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolveBootstrapB = resolve;
      });
      const { rest } = fakeRest({
        bootstrapImpl: async (conversationId) =>
          conversationId === 'conv-b'
            ? bootstrapB
            : v2Bootstrap({ conversation: v2Summary({ id: conversationId }) }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const openingB = store.getState().openConversation('conv-b');

      expect(store.getState().connection).toBe('reconnecting');
      expect(scripted.sockets[0].closed).toBe(true);
      expect(scripted.sockets).toHaveLength(1);

      resolveBootstrapB(v2Bootstrap({ conversation: v2Summary({ id: 'conv-b' }) }));
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[1].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );
      expect(store.getState().connection).toBe('reconnecting');
      acknowledgeSubscription(scripted, 1, 'conv-b');
      await openingB;
      expect(store.getState().connection).toBe('connected');
    });

    it('does not let a stale reconnect failure reject the next conversation subscription', async () => {
      const { rest } = fakeRest({
        bootstrapImpl: async (conversationId) =>
          v2Bootstrap({ conversation: v2Summary({ id: conversationId }) }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));

      const openingB = store.getState().openConversation('conv-b');
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(3));
      scripted.sockets[2].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[2].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );

      scripted.sockets[1].failToOpen();
      acknowledgeSubscription(scripted, 2, 'conv-b');
      await openingB;

      expect(store.getState().connection).toBe('connected');
      expect(scripted.sockets[2].closed).toBe(false);
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);
      expect(scripted.factory).toHaveBeenCalledTimes(3);
    });

    it('does not schedule a reconnect for the current conversation after a stale bootstrap fails', async () => {
      let aBootstrapCalls = 0;
      let rejectReconnectBootstrap!: (error: Error) => void;
      const reconnectBootstrap = new Promise<MobileV2ConversationBootstrap>((_resolve, reject) => {
        rejectReconnectBootstrap = reject;
      });
      const { rest } = fakeRest({
        bootstrapImpl: async (conversationId) => {
          if (conversationId === 'conv-b') {
            return v2Bootstrap({ conversation: v2Summary({ id: conversationId }) });
          }
          aBootstrapCalls += 1;
          if (aBootstrapCalls === 1) return v2Bootstrap();
          if (aBootstrapCalls === 2) throw new Error('force reconnect');
          return reconnectBootstrap;
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      await store.getState().openConversation(CONVERSATION_ID);
      expect(store.getState().connection).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(aBootstrapCalls).toBe(3));

      const openingB = store.getState().openConversation('conv-b');
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[1].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );
      acknowledgeSubscription(scripted, 1, 'conv-b');
      await openingB;

      rejectReconnectBootstrap(new Error('late A bootstrap failure'));
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS * 2);

      expect(store.getState().connection).toBe('connected');
      expect(scripted.sockets[1].closed).toBe(false);
      expect(scripted.factory).toHaveBeenCalledTimes(2);
    });

    it('does not let a stale reconnect-exhaustion probe mark a newer conversation offline', async () => {
      let resolveIdentity!: (identity: { gatewayId: string; publicKey: string }) => void;
      const identityResult = new Promise<{ gatewayId: string; publicKey: string }>((resolve) => {
        resolveIdentity = resolve;
      });
      const { rest, identity } = fakeRest({
        bootstrapImpl: async (conversationId) =>
          v2Bootstrap({ conversation: v2Summary({ id: conversationId }) }),
        identityImpl: async () => identityResult,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
        reconnect: { maxAttempts: 0 },
      });
      await openV2Conversation(store, scripted);

      scripted.onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(1));

      const openingB = store.getState().openConversation('conv-b');
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[1].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );
      acknowledgeSubscription(scripted, 1, 'conv-b');
      await openingB;

      resolveIdentity({ gatewayId: 'gw-1', publicKey: 'pk-stub' });
      await identityResult;
      await Promise.resolve();

      expect(store.getState().connection).toBe('connected');
      expect(scripted.sockets[1].closed).toBe(false);
      expect(scripted.factory).toHaveBeenCalledTimes(2);
    });

    it('keeps a forced bootstrap required when reopening a cached conversation fails transiently', async () => {
      let bootstrapCall = 0;
      const recovered = pendingInput({ inputId: 'recovered-input' });
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          if (bootstrapCall === 2) throw new Error('temporary bootstrap failure');
          return bootstrapCall === 1
            ? v2Bootstrap()
            : v2Bootstrap({ pendingInputs: [recovered], v2ThroughSeq: 4 });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      await store.getState().openConversation(CONVERSATION_ID);
      expect(store.getState().connection).toBe('reconnecting');
      expect(bootstrap).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[1].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );
      acknowledgeSubscription(scripted, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
      expect(store.getState().v2Transcripts[CONVERSATION_ID].inputs).toHaveProperty(
        recovered.inputId,
      );
    });

    it('terminalizes a subscription acknowledgement whose matching id names another conversation', async () => {
      const { rest } = fakeRest({ bootstrapImpl: async () => v2Bootstrap() });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() => expect(scripted.sockets[0].sent).toHaveLength(1));
      const subscription = scripted.sockets[0].sent[0];
      if (subscription.type !== 'subscribe_conversation') {
        throw new Error('expected subscribe command');
      }
      scripted.onFrames[0]({
        type: 'conversation_subscribed',
        id: subscription.id,
        conversationId: 'foreign-conversation',
        v2ThroughSeq: 0,
      });

      await opening;
      expect(store.getState().connection).toBe('offline');
      expect(store.getState().v2Transcripts[CONVERSATION_ID].error?.message).toContain(
        'Invalid v2 frame correlation',
      );
    });

    it('terminalizes a subscription rejection that omits the matching conversation id', async () => {
      const { rest } = fakeRest({ bootstrapImpl: async () => v2Bootstrap() });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() => expect(scripted.sockets[0].sent).toHaveLength(1));
      const subscription = scripted.sockets[0].sent[0];
      if (subscription.type !== 'subscribe_conversation') {
        throw new Error('expected subscribe command');
      }
      scripted.onFrames[0]({
        type: 'command_rejected',
        id: subscription.id,
        code: 'validation_failed',
        error: 'missing conversation correlation',
        retryable: false,
      });

      await opening;
      expect(store.getState().connection).toBe('offline');
    });

    it('reconnects with a subscription from the live v2 cursor and never sends v1 resume', async () => {
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ v2ThroughSeq: 3 }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);
      scripted.onFrames[0](inputFrame('input_accepted', 4, pendingInput()));
      expect(store.getState().v2Transcripts[CONVERSATION_ID].lastAppliedV2Seq).toBe(4);

      scripted.onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(1));

      expect(subscriptionFrame(scripted.sockets[1])).toMatchObject({
        conversationId: CONVERSATION_ID,
        sinceV2Seq: 4,
      });
      expect(scripted.sockets[1].sent.some((frame) => frame.type === 'resume')).toBe(false);
      expect(getMessagesV2).not.toHaveBeenCalled();

      scripted.onFrames[1](
        eventFrame(5, {
          runId: 'run-4',
          segmentTurnId: 'segment-4',
        }),
      );
      acknowledgeSubscription(scripted, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
      expect(store.getState().v2Transcripts[CONVERSATION_ID].lastAppliedV2Seq).toBe(5);
    });

    it('walks every older v2 message page after subscribe without adopting page throughSeq', async () => {
      const newest = v2Message({
        id: 'assistant-4',
        turnId: 'segment-4',
        runId: 'run-4',
        ordinal: 4,
        role: 'assistant',
        content: { type: 'assistant', events: [] },
        segmentIndex: 2,
        deliveryKind: 'follow_up',
        deliveryStatus: 'delivered',
      });
      const pages: MobileV2ConversationMessagePage[] = [
        {
          items: [
            v2Message({ id: 'user-2', ordinal: 2, runId: 'run-2', segmentIndex: 1 }),
            v2Message({
              id: 'assistant-3',
              ordinal: 3,
              role: 'assistant',
              content: { type: 'assistant', events: [] },
              runId: 'run-2',
              turnId: 'segment-2',
              segmentIndex: 1,
              deliveryKind: 'steer',
              deliveryStatus: 'delivered',
            }),
          ],
          nextCursor: 'older-2',
          throughSeq: 800,
        },
        {
          items: [v2Message({ id: 'user-1', ordinal: 1 })],
          nextCursor: null,
          throughSeq: 900,
        },
      ];
      let pageIndex = 0;
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({ messages: [newest], nextCursor: 'older-1', v2ThroughSeq: 12 }),
        getMessagesV2Impl: async () => pages[pageIndex++],
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      await openV2Conversation(store, scripted);

      expect(getMessagesV2.mock.calls).toEqual([
        [CONVERSATION_ID, 'older-1'],
        [CONVERSATION_ID, 'older-2'],
      ]);
      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      expect(Object.values(transcript.messages).map((item) => item.id)).toEqual([
        'assistant-4',
        'user-2',
        'assistant-3',
        'user-1',
      ]);
      expect(transcript.messages['assistant-4']).toMatchObject({
        runId: 'run-4',
        segmentIndex: 2,
        deliveryKind: 'follow_up',
        deliveryStatus: 'delivered',
      });
      expect(transcript.nextCursor).toBeNull();
      expect(transcript.lastAppliedV2Seq).toBe(12);
      expect(transcript.conversation.v2LastSeq).toBe(12);
    });

    it('does not resurrect an older cursor when duplicate same-cursor history requests resolve late', async () => {
      let resolveWalkFirst!: (page: MobileV2ConversationMessagePage) => void;
      let resolveManualDuplicate!: (page: MobileV2ConversationMessagePage) => void;
      let resolveWalkSecond!: (page: MobileV2ConversationMessagePage) => void;
      const walkFirst = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveWalkFirst = resolve;
      });
      const manualDuplicate = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveManualDuplicate = resolve;
      });
      const walkSecond = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveWalkSecond = resolve;
      });
      let pageCall = 0;
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ nextCursor: 'cursor-1' }),
        getMessagesV2Impl: async () => {
          pageCall += 1;
          if (pageCall === 1) return walkFirst;
          if (pageCall === 2) return manualDuplicate;
          return walkSecond;
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );
      acknowledgeSubscription(scripted, 0);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(1));

      const manualLoad = store.getState().loadOlderMessages(CONVERSATION_ID);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(2));

      resolveWalkFirst({
        items: [v2Message({ id: 'page-1', ordinal: 1 })],
        nextCursor: 'cursor-2',
        throughSeq: 10,
      });
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(3));
      resolveWalkSecond({
        items: [v2Message({ id: 'page-2', ordinal: 0 })],
        nextCursor: null,
        throughSeq: 10,
      });
      await opening;
      expect(store.getState().v2Transcripts[CONVERSATION_ID].nextCursor).toBeNull();

      resolveManualDuplicate({
        items: [v2Message({ id: 'stale-duplicate', ordinal: 1 })],
        nextCursor: 'cursor-2',
        throughSeq: 10,
      });
      await manualLoad;

      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      expect(transcript.nextCursor).toBeNull();
      expect(transcript.messages).not.toHaveProperty('stale-duplicate');
    });

    it('continues the automatic history walk when a duplicate manual request advances its cursor', async () => {
      let resolveWalkDuplicate!: (page: MobileV2ConversationMessagePage) => void;
      let resolveManualFirst!: (page: MobileV2ConversationMessagePage) => void;
      let resolveWalkNext!: (page: MobileV2ConversationMessagePage) => void;
      const walkDuplicate = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveWalkDuplicate = resolve;
      });
      const manualFirst = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveManualFirst = resolve;
      });
      const walkNext = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveWalkNext = resolve;
      });
      let pageCall = 0;
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ nextCursor: 'cursor-1' }),
        getMessagesV2Impl: async () => {
          pageCall += 1;
          if (pageCall === 1) return walkDuplicate;
          if (pageCall === 2) return manualFirst;
          return walkNext;
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.some((frame) => frame.type === 'subscribe_conversation'),
        ).toBe(true),
      );
      acknowledgeSubscription(scripted, 0);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(1));

      const manualLoad = store.getState().loadOlderMessages(CONVERSATION_ID);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(2));
      resolveManualFirst({
        items: [
          v2Message({ id: 'page-1', turnId: 'turn-page-1', runId: 'run-page-1', ordinal: 1 }),
        ],
        nextCursor: 'cursor-2',
        throughSeq: 10,
      });
      await manualLoad;
      expect(store.getState().v2Transcripts[CONVERSATION_ID].nextCursor).toBe('cursor-2');

      resolveWalkDuplicate({
        items: [
          v2Message({
            id: 'stale-duplicate',
            turnId: 'turn-stale',
            runId: 'run-stale',
            ordinal: 1,
          }),
        ],
        nextCursor: 'cursor-2',
        throughSeq: 10,
      });
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(3));
      resolveWalkNext({
        items: [
          v2Message({ id: 'page-2', turnId: 'turn-page-2', runId: 'run-page-2', ordinal: 0 }),
        ],
        nextCursor: null,
        throughSeq: 10,
      });
      await opening;

      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      expect(transcript.nextCursor).toBeNull();
      expect(transcript.messages).toHaveProperty('page-2');
      expect(transcript.messages).not.toHaveProperty('stale-duplicate');
    });

    it('discards a late older page across an A to B to A navigation generation', async () => {
      let resolveOldPage!: (page: MobileV2ConversationMessagePage) => void;
      const oldPage = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveOldPage = resolve;
      });
      let aBootstrapCount = 0;
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async (conversationId) => {
          if (conversationId !== CONVERSATION_ID) {
            return v2Bootstrap({ conversation: v2Summary({ id: conversationId }) });
          }
          aBootstrapCount += 1;
          return v2Bootstrap({
            conversation: v2Summary({ id: conversationId }),
            messages: [
              v2Message({
                id: aBootstrapCount === 1 ? 'old-bootstrap' : 'fresh-bootstrap',
              }),
            ],
            nextCursor: aBootstrapCount === 1 ? 'old-cursor' : null,
          });
        },
        getMessagesV2Impl: async () => oldPage,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const firstA = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() => expect(scripted.sockets[0].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 0);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(1));

      const openingB = store.getState().openConversation('conv-b');
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 1, 'conv-b');
      await openingB;

      const secondA = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(3));
      scripted.sockets[2].open();
      await vi.waitFor(() => expect(scripted.sockets[2].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 2);
      await secondA;

      resolveOldPage({
        items: [v2Message({ id: 'stale-history', ordinal: 0 })],
        nextCursor: null,
        throughSeq: 999,
      });
      await firstA;

      expect(Object.keys(store.getState().v2Transcripts[CONVERSATION_ID].messages)).toEqual([
        'fresh-bootstrap',
      ]);
      expect(aBootstrapCount).toBe(2);
    });

    it('keeps newer live segment data when an overlapping older page resolves later', async () => {
      const assistant = v2Message({
        id: 'assistant-live',
        role: 'assistant',
        status: 'streaming',
        content: { type: 'assistant', events: [{ type: 'text_delta', text: 'before' }] },
        ordinal: 2,
        runId: 'run-live',
        turnId: 'segment-live',
        segmentIndex: 2,
        deliveryKind: 'follow_up',
        deliveryStatus: 'delivered',
      });
      let resolvePage!: (page: MobileV2ConversationMessagePage) => void;
      const pagePromise = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolvePage = resolve;
      });
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({
            conversation: v2Summary({ activeTurnId: 'run-live', status: 'running' }),
            messages: [assistant],
            nextCursor: 'older',
            v2ThroughSeq: 1,
          }),
        getMessagesV2Impl: async () => pagePromise,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() => expect(scripted.sockets[0].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 0);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(1));

      scripted.onFrames[0](eventFrame(2, { runId: 'run-live', segmentTurnId: 'segment-live' }));
      resolvePage({
        items: [
          v2Message({
            id: 'steer-history',
            ordinal: 1,
            runId: 'run-live',
            turnId: 'steer-segment',
            segmentIndex: 1,
            deliveryKind: 'steer',
            deliveryStatus: 'delivered',
          }),
          { ...assistant, content: { type: 'assistant', events: [] } },
        ],
        nextCursor: null,
        throughSeq: 999,
      });
      await opening;

      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      expect(transcript.liveSegments['assistant-live'].events).toEqual([
        { type: 'text_delta', text: 'before' },
        { type: 'text_delta', text: 'delta-2' },
      ]);
      expect(transcript.messages['assistant-live']).toMatchObject({
        runId: 'run-live',
        segmentIndex: 2,
        deliveryKind: 'follow_up',
        deliveryStatus: 'delivered',
      });
      expect(transcript.messages['steer-history']).toMatchObject({
        runId: 'run-live',
        segmentIndex: 1,
        deliveryKind: 'steer',
        deliveryStatus: 'delivered',
      });
      expect(transcript.lastAppliedV2Seq).toBe(2);
    });

    it('refreshes and resubscribes on a v2 sequence gap without reducing the gap frame', async () => {
      let bootstrapCall = 0;
      const authoritative = pendingInput({ inputId: 'authoritative', revision: 4 });
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1
            ? v2Bootstrap({ v2ThroughSeq: 2 })
            : v2Bootstrap({ pendingInputs: [authoritative], v2ThroughSeq: 4 });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](
        inputFrame('input_accepted', 4, pendingInput({ inputId: 'gap-value' }), {
          id: 'gap-command',
        }),
      );
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      expect(store.getState().v2Transcripts[CONVERSATION_ID].inputs).not.toHaveProperty(
        'gap-value',
      );
      expect(store.getState().v2Transcripts[CONVERSATION_ID].inputs).toHaveProperty(
        'authoritative',
      );
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    });

    it('settles an ordinary v2 send only from its matching accepted frame', async () => {
      const { rest } = fakeRest({});
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      let settled = false;
      const sending = store
        .getState()
        .sendMessage(CONVERSATION_ID, 'hello')
        .then(() => {
          settled = true;
        });
      const outgoing = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'message' }> =>
          frame.type === 'message',
      );
      if (!outgoing) throw new Error('expected ordinary v2 message');
      expect(settled).toBe(false);

      scripted.onFrames[0](inputFrame('input_accepted', 1, pendingInput(), { id: outgoing.id }));
      await Promise.resolve();
      expect(settled).toBe(false);

      scripted.onFrames[0](
        acceptedFrame(2, {
          id: outgoing.id,
          runId: outgoing.id,
          segmentTurnId: 'ordinary-segment',
          userMessageId: 'ordinary-user',
          assistantMessageId: 'ordinary-assistant',
        }),
      );
      await sending;

      expect(settled).toBe(true);
      expect(store.getState().v2Transcripts[CONVERSATION_ID].messages).toHaveProperty(
        'ordinary-user',
      );
      expect(store.getState().v2Transcripts[CONVERSATION_ID].messages).not.toHaveProperty(
        `optimistic:${outgoing.id}`,
      );
    });

    it('restores a schema-complete failed send after bootstrap replaces its optimistic row', async () => {
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1 ? v2Bootstrap() : v2Bootstrap({ v2ThroughSeq: 2 });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const sending = store
        .getState()
        .sendMessage(CONVERSATION_ID, 'preserve this failed send', [
          { mediaType: 'image/png', data: 'AA==' },
        ]);
      const outgoing = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'message' }> =>
          frame.type === 'message',
      );
      if (!outgoing) throw new Error('expected ordinary v2 message');
      const optimisticId = `optimistic:${outgoing.id}`;

      scripted.onFrames[0](eventFrame(2));
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      expect(store.getState().v2Transcripts[CONVERSATION_ID].messages).not.toHaveProperty(
        optimisticId,
      );

      scripted.onFrames[0]({
        type: 'command_rejected',
        id: outgoing.id,
        conversationId: CONVERSATION_ID,
        code: 'validation_failed',
        error: 'send rejected',
        retryable: false,
      });
      await expect(sending).rejects.toMatchObject({ code: 'validation_failed' });

      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      expect(transcript.messages[optimisticId]).toMatchObject({
        id: optimisticId,
        conversationId: CONVERSATION_ID,
        turnId: outgoing.id,
        runId: outgoing.id,
        segmentIndex: 0,
        deliveryKind: 'normal',
        role: 'user',
        status: 'failed',
        content: {
          type: 'user',
          text: 'preserve this failed send',
          images: [{ mediaType: 'image/png', data: 'AA==' }],
        },
      });
      expect(transcript.timeline).toContainEqual({ kind: 'message', messageId: optimisticId });

      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
    });

    it('uses distinct command/input UUIDs, targets the active run for Steer, and preserves FIFO Follow Ups', async () => {
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({
            conversation: v2Summary({ activeTurnId: 'active-run', status: 'running' }),
          }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const steerPromise = store.getState().enqueueInput(CONVERSATION_ID, 'steer', 'change course');
      const firstFollowUpPromise = store
        .getState()
        .enqueueInput(CONVERSATION_ID, 'followUp', 'first');
      const secondFollowUpPromise = store
        .getState()
        .enqueueInput(CONVERSATION_ID, 'followUp', 'second');
      const commands = scripted.sockets[0].sent.filter(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'enqueue_input' }> =>
          frame.type === 'enqueue_input',
      );
      expect(commands).toHaveLength(3);
      expect(commands[0].id).not.toBe(commands[0].inputId);
      expect(commands[0]).toMatchObject({
        behavior: 'steer',
        expectedActiveTurnId: 'active-run',
      });

      scripted.onFrames[0](
        inputFrame(
          'input_accepted',
          1,
          pendingInput({
            inputId: commands[0].inputId,
            kind: 'steer',
            targetTurnId: 'active-run',
            text: 'change course',
          }),
          { id: commands[0].id },
        ),
      );
      scripted.onFrames[0](
        inputFrame(
          'input_accepted',
          2,
          pendingInput({ inputId: commands[1].inputId, text: 'first', enqueueOrder: 1 }),
          { id: commands[1].id },
        ),
      );
      scripted.onFrames[0](
        inputFrame(
          'input_accepted',
          3,
          pendingInput({ inputId: commands[2].inputId, text: 'second', enqueueOrder: 2 }),
          { id: commands[2].id },
        ),
      );
      await Promise.all([steerPromise, firstFollowUpPromise, secondFollowUpPromise]);

      expect(store.getState().v2Transcripts[CONVERSATION_ID].queueOrder).toEqual([
        commands[1].inputId,
        commands[2].inputId,
      ]);
    });

    it('retains and resends the exact durable command after a retryable reconnect', async () => {
      const queued = pendingInput();
      const { rest } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ pendingInputs: [queued] }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const editing = store
        .getState()
        .editFollowUp(CONVERSATION_ID, queued.inputId, queued.revision, 'edited');
      const command = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'edit_follow_up' }> =>
          frame.type === 'edit_follow_up',
      );
      if (!command) throw new Error('expected edit command');

      scripted.onCloses[0](RETRYABLE_CLOSED_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 1);
      await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(2));
      expect(scripted.sockets[1].sent[1]).toEqual(command);

      const updated = pendingInput({ inputId: queued.inputId, text: 'edited', revision: 2 });
      scripted.onFrames[1](inputFrame('input_updated', 1, updated, { id: command.id }));
      await expect(editing).resolves.toEqual(updated);
    });

    it('settles a replayed command before duplicate reduction and does not resend it after subscribe', async () => {
      const queued = pendingInput();
      const { rest } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ pendingInputs: [queued], v2ThroughSeq: 1 }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const removing = store
        .getState()
        .removeFollowUp(CONVERSATION_ID, queued.inputId, queued.revision);
      const command = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'remove_follow_up' }> =>
          frame.type === 'remove_follow_up',
      );
      if (!command) throw new Error('expected remove command');
      scripted.onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(1));

      scripted.onFrames[1](
        inputFrame(
          'input_removed',
          1,
          pendingInput({ inputId: queued.inputId, state: 'removed', revision: 2 }),
          { id: command.id },
        ),
      );
      await expect(removing).resolves.toBeUndefined();
      acknowledgeSubscription(scripted, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
      expect(scripted.sockets[1].sent).toHaveLength(1);
    });

    it('terminalizes a sequenced frame for a retained transcript that is foreign to the live subscription', async () => {
      const { rest } = fakeRest({
        bootstrapImpl: async (conversationId) =>
          v2Bootstrap({ conversation: v2Summary({ id: conversationId }) }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted, CONVERSATION_ID);
      await openV2Conversation(store, scripted, 'conv-live');

      scripted.onFrames[1](inputFrame('input_accepted', 1, pendingInput()));

      expect(store.getState().connection).toBe('offline');
      expect(store.getState().v2Transcripts[CONVERSATION_ID].inputs).toEqual({});
      expect(store.getState().v2Transcripts['conv-live'].error?.message).toContain(
        'Invalid v2 frame correlation',
      );
    });

    it('rejects only the matching command without terminalizing the active run', async () => {
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({
            conversation: v2Summary({ activeTurnId: 'active-run', status: 'running' }),
          }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      let settled = false;
      const enqueueing = store
        .getState()
        .enqueueInput(CONVERSATION_ID, 'followUp', 'later')
        .finally(() => {
          settled = true;
        });
      const command = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'enqueue_input' }> =>
          frame.type === 'enqueue_input',
      );
      if (!command) throw new Error('expected enqueue command');
      scripted.onFrames[0]({
        type: 'command_rejected',
        id: 'other-command',
        conversationId: CONVERSATION_ID,
        code: 'validation_failed',
        error: 'other failure',
        retryable: false,
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      scripted.onFrames[0]({
        type: 'command_rejected',
        id: command.id,
        conversationId: CONVERSATION_ID,
        code: 'validation_failed',
        error: 'cannot queue',
        retryable: false,
      });
      await expect(enqueueing).rejects.toMatchObject({ code: 'validation_failed' });
      expect(store.getState().connection).toBe('connected');
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        activeTurnId: 'active-run',
        status: 'running',
      });
    });

    it('terminalizes a command rejection whose matching id names another conversation', async () => {
      const { rest } = fakeRest({ bootstrapImpl: async () => v2Bootstrap() });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const enqueueing = store
        .getState()
        .enqueueInput(CONVERSATION_ID, 'followUp', 'later')
        .catch((error: unknown) => error);
      const command = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'enqueue_input' }> =>
          frame.type === 'enqueue_input',
      );
      if (!command) throw new Error('expected enqueue command');
      scripted.onFrames[0]({
        type: 'command_rejected',
        id: command.id,
        conversationId: 'foreign-conversation',
        code: 'validation_failed',
        error: 'foreign conversation correlation',
        retryable: false,
      });

      expect(await enqueueing).toBeInstanceOf(Error);
      expect(store.getState().connection).toBe('offline');
    });

    it('refreshes bootstrap atomically, resubscribes, and rethrows a revision conflict', async () => {
      const queued = pendingInput({ text: 'server original' });
      const refreshed = pendingInput({ text: 'server authoritative', revision: 7 });
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1
            ? v2Bootstrap({ pendingInputs: [queued], v2ThroughSeq: 2 })
            : v2Bootstrap({
                pendingInputs: [refreshed],
                queueRevision: 7,
                v2ThroughSeq: 9,
              });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const editing = store
        .getState()
        .editFollowUp(CONVERSATION_ID, queued.inputId, queued.revision, 'keep this draft');
      const command = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'edit_follow_up' }> =>
          frame.type === 'edit_follow_up',
      );
      if (!command) throw new Error('expected edit command');
      scripted.onFrames[0]({
        type: 'command_rejected',
        id: command.id,
        conversationId: CONVERSATION_ID,
        code: 'revision_conflict',
        error: 'stale input revision',
        retryable: true,
        details: { currentRevision: 7 },
      });

      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      expect(store.getState().v2Transcripts[CONVERSATION_ID]).toMatchObject({
        queueRevision: 7,
        lastAppliedV2Seq: 9,
        inputs: { [queued.inputId]: { text: 'server authoritative', revision: 7 } },
      });
      expect(command.text).toBe('keep this draft');

      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
      await expect(editing).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(store.getState().connection).toBe('connected');
    });

    it.each(['remove', 'resume'] as const)(
      'uses the projection baseline and refreshes before rethrowing a %s revision conflict',
      async (operation) => {
        const queued = pendingInput({ revision: 2 });
        const refreshed = pendingInput({ text: 'fresh baseline', revision: 8 });
        let bootstrapCall = 0;
        const { rest, bootstrap } = fakeRest({
          bootstrapImpl: async () => {
            bootstrapCall += 1;
            return bootstrapCall === 1
              ? v2Bootstrap({
                  pendingInputs: [queued],
                  queuePaused: operation === 'resume',
                  queueRevision: 2,
                  v2ThroughSeq: 2,
                })
              : v2Bootstrap({
                  pendingInputs: [refreshed],
                  queuePaused: operation === 'resume',
                  queueRevision: 8,
                  v2ThroughSeq: 8,
                });
          },
        });
        const scripted = scriptedSocketFactory();
        const store = createTestStore({
          protocol: V2_PROTOCOL,
          rest,
          socketFactory: scripted.factory,
        });
        await openV2Conversation(store, scripted);

        const mutation =
          operation === 'remove'
            ? store.getState().removeFollowUp(CONVERSATION_ID, queued.inputId, queued.revision)
            : store.getState().resumeFollowUps(CONVERSATION_ID);
        const command = scripted.sockets[0].sent.at(-1);
        if (!command) throw new Error('expected mutation command');
        scripted.onFrames[0]({
          type: 'command_rejected',
          id: command.id,
          conversationId: CONVERSATION_ID,
          code: 'revision_conflict',
          error: 'stale projection',
          retryable: true,
          details: { currentRevision: 8 },
        });

        await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
        await vi.waitFor(() =>
          expect(
            scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
          ).toHaveLength(2),
        );
        acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
        await expect(mutation).rejects.toMatchObject({ code: 'revision_conflict' });
        expect(store.getState().v2Transcripts[CONVERSATION_ID]).toMatchObject({
          queueRevision: 8,
          inputs: { [queued.inputId]: { text: 'fresh baseline', revision: 8 } },
        });
      },
    );

    it.each(['edit', 'remove', 'resume'] as const)(
      'keeps a newer %s attempt pending when an A to B to A stale completion arrives',
      async (operation) => {
        const oldInput = pendingInput({ text: 'old', revision: 1 });
        const freshInput = pendingInput({ text: 'fresh', revision: 7 });
        let aOpenCount = 0;
        const { rest } = fakeRest({
          bootstrapImpl: async (conversationId) => {
            if (conversationId === 'conv-b') {
              return v2Bootstrap({ conversation: v2Summary({ id: 'conv-b' }) });
            }
            aOpenCount += 1;
            const input = aOpenCount === 1 ? oldInput : freshInput;
            return v2Bootstrap({
              pendingInputs: [input],
              queuePaused: operation === 'resume',
              queueRevision: input.revision,
              v2ThroughSeq: aOpenCount === 1 ? 0 : 10,
            });
          },
        });
        const scripted = scriptedSocketFactory();
        const store = createTestStore({
          protocol: V2_PROTOCOL,
          rest,
          socketFactory: scripted.factory,
        });
        await openV2Conversation(store, scripted);

        const invoke = () => {
          if (operation === 'edit') {
            return store
              .getState()
              .editFollowUp(CONVERSATION_ID, oldInput.inputId, oldInput.revision, 'edited');
          }
          if (operation === 'remove') {
            return store
              .getState()
              .removeFollowUp(CONVERSATION_ID, oldInput.inputId, oldInput.revision);
          }
          return store.getState().resumeFollowUps(CONVERSATION_ID);
        };
        const first = invoke().then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        const oldCommand = scripted.sockets[0].sent.at(-1) as TestClientFrame;

        const openingB = store.getState().openConversation('conv-b');
        await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
        scripted.sockets[1].open();
        await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(1));
        acknowledgeSubscription(scripted, 1, 'conv-b');
        await openingB;
        await expect(first).resolves.toBe('Conversation changed');

        await openV2Conversation(store, scripted);
        let newerSettled = false;
        const newer = invoke().finally(() => {
          newerSettled = true;
        });
        const currentSocketIndex = 2;
        const newCommand = scripted.sockets[currentSocketIndex].sent.at(-1) as TestClientFrame;

        const completionFor = (command: TestClientFrame, v2Seq: number): MobileV2SequencedFrame => {
          if (operation === 'edit') {
            return inputFrame(
              'input_updated',
              v2Seq,
              pendingInput({ inputId: freshInput.inputId, text: 'edited', revision: 8 }),
              { id: command.id },
            );
          }
          if (operation === 'remove') {
            return inputFrame(
              'input_removed',
              v2Seq,
              pendingInput({ inputId: freshInput.inputId, state: 'removed', revision: 8 }),
              { id: command.id },
            );
          }
          return {
            type: 'queue_resumed',
            id: command.id,
            conversationId: CONVERSATION_ID,
            v2Seq,
            queueRevision: 8,
            queuePaused: false,
            pendingFollowUpCount: 1,
          };
        };

        scripted.onFrames[0](completionFor(oldCommand, 11));
        await Promise.resolve();
        expect(newerSettled).toBe(false);
        expect(store.getState().v2Transcripts[CONVERSATION_ID].inputs[oldInput.inputId].text).toBe(
          'fresh',
        );

        scripted.onFrames[currentSocketIndex](completionFor(newCommand, 11));
        await newer;
        expect(newerSettled).toBe(true);
      },
    );

    it('projects remote queue mutations without requiring a local command', async () => {
      const queued = pendingInput();
      const { rest } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ pendingInputs: [queued] }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](
        inputFrame(
          'input_updated',
          1,
          pendingInput({ inputId: queued.inputId, text: 'remote edit', revision: 2 }),
          { id: 'remote-edit' },
        ),
      );
      scripted.onFrames[0]({
        type: 'queue_paused',
        id: 'remote-pause',
        conversationId: CONVERSATION_ID,
        v2Seq: 2,
        queueRevision: 3,
        queuePaused: true,
        pendingFollowUpCount: 1,
      });

      expect(store.getState().v2Transcripts[CONVERSATION_ID]).toMatchObject({
        queuePaused: true,
        queueRevision: 3,
        inputs: { [queued.inputId]: { text: 'remote edit', revision: 2 } },
      });
    });

    it('preserves a failed Steer and resumes a paused Follow Up queue on the same socket', async () => {
      const queued = pendingInput({ inputId: 'follow-up-1' });
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({
            conversation: v2Summary({ activeTurnId: 'active-run', status: 'running' }),
            pendingInputs: [queued],
          }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const steering = store.getState().enqueueInput(CONVERSATION_ID, 'steer', 'try another way');
      const steerCommand = scripted.sockets[0].sent.at(-1) as Extract<
        TestClientFrame,
        { type: 'enqueue_input' }
      >;
      const acceptedSteer = pendingInput({
        inputId: steerCommand.inputId,
        kind: 'steer',
        targetTurnId: 'active-run',
        text: 'try another way',
      });
      scripted.onFrames[0](inputFrame('input_accepted', 1, acceptedSteer, { id: steerCommand.id }));
      await steering;
      scripted.onFrames[0](
        inputFrame(
          'input_failed',
          2,
          {
            ...acceptedSteer,
            state: 'failed',
            revision: 2,
            failureCode: 'gateway_offline',
            failureMessage: 'delivery failed',
          },
          { id: 'remote-failure' },
        ),
      );
      scripted.onFrames[0]({
        type: 'queue_paused',
        id: 'remote-pause',
        conversationId: CONVERSATION_ID,
        v2Seq: 3,
        queueRevision: 3,
        queuePaused: true,
        pendingFollowUpCount: 1,
      });
      expect(
        store.getState().v2Transcripts[CONVERSATION_ID].inputs[steerCommand.inputId],
      ).toMatchObject({ state: 'failed', failureMessage: 'delivery failed' });
      expect(
        store
          .getState()
          .v2Transcripts[CONVERSATION_ID].timeline.some(
            (entry) => entry.kind === 'input' && entry.inputId === steerCommand.inputId,
          ),
      ).toBe(true);

      const resuming = store.getState().resumeFollowUps(CONVERSATION_ID);
      const resumeCommand = scripted.sockets[0].sent.at(-1) as Extract<
        TestClientFrame,
        { type: 'resume_follow_ups' }
      >;
      expect(resumeCommand.expectedQueueRevision).toBe(3);
      scripted.onFrames[0]({
        type: 'queue_resumed',
        id: resumeCommand.id,
        conversationId: CONVERSATION_ID,
        v2Seq: 4,
        queueRevision: 4,
        queuePaused: false,
        pendingFollowUpCount: 1,
      });
      await resuming;
      expect(store.getState().v2Transcripts[CONVERSATION_ID].queuePaused).toBe(false);
      expect(scripted.sockets[0].closed).toBe(false);
    });

    it('keeps the socket subscribed while Stop completes and a Follow Up is promoted', async () => {
      const queued = pendingInput();
      let resolvePromotionRefresh!: (bootstrap: MobileV2ConversationBootstrap) => void;
      const promotionRefresh = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolvePromotionRefresh = resolve;
      });
      let bootstrapCall = 0;
      const { rest } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          if (bootstrapCall > 1) return promotionRefresh;
          return v2Bootstrap({
            conversation: v2Summary({ activeTurnId: 'run-1', status: 'running' }),
            pendingInputs: [queued],
          });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      store.getState().cancelTurn(CONVERSATION_ID);
      expect(scripted.sockets[0].sent.at(-1)).toEqual({ type: 'cancel', id: 'run-1' });
      scripted.onFrames[0](
        doneFrame(1, { runId: 'run-1', segmentTurnId: 'segment-1', outcome: 'cancelled' }),
      );
      const delivered = pendingInput({
        ...queued,
        state: 'delivered',
        revision: 2,
        runId: 'run-2',
        segmentTurnId: 'segment-2',
        userMessageId: 'user-2',
        assistantMessageId: 'assistant-2',
      });
      scripted.onFrames[0](
        deliveredFrame(2, delivered, {
          runId: 'run-2',
          segmentTurnId: 'segment-2',
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
        }),
      );
      scripted.onFrames[0](
        acceptedFrame(3, {
          id: 'promotion',
          runId: 'run-2',
          segmentTurnId: 'segment-2',
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
        }),
      );
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation.activeTurnId).toBe(
        'run-2',
      );
      expect(scripted.sockets[0].closed).toBe(false);
      expect(store.getState().connection).toBe('connected');

      scripted.onFrames[0](
        doneFrame(4, { id: 'late-done', runId: 'run-1', segmentTurnId: 'segment-1' }),
      );
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation.activeTurnId).toBe(
        'run-2',
      );

      resolvePromotionRefresh(
        v2Bootstrap({
          conversation: v2Summary({
            activeTurnId: 'run-2',
            status: 'running',
            v2LastSeq: 4,
          }),
          pendingInputs: [delivered],
          v2ThroughSeq: 4,
        }),
      );
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    });

    it('keeps v2 rename state authoritative across later projection writes', async () => {
      const renamed = summary({ title: 'Renamed thread', revision: 8 });
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({ conversation: v2Summary({ title: 'Original title', revision: 7 }) }),
        patchConversationImpl: async () => renamed,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      await store.getState().renameConversation(CONVERSATION_ID, renamed.title);
      scripted.onFrames[0](inputFrame('input_accepted', 1, pendingInput()));

      expect(
        store.getState().conversations.find((item) => item.id === CONVERSATION_ID),
      ).toMatchObject({ title: renamed.title, revision: renamed.revision });
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        title: renamed.title,
        revision: renamed.revision,
      });
    });

    it('does not resurrect a v2 row during delete and purges its projection on success', async () => {
      let resolveDelete!: (value: ConversationSummary) => void;
      const deletingResponse = new Promise<ConversationSummary>((resolve) => {
        resolveDelete = resolve;
      });
      const { rest } = fakeRest({ deleteConversationImpl: async () => deletingResponse });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const deleting = store.getState().deleteConversation(CONVERSATION_ID);
      expect(store.getState().conversations).toHaveLength(0);
      scripted.onFrames[0](inputFrame('input_accepted', 1, pendingInput()));
      expect(store.getState().conversations).toHaveLength(0);

      resolveDelete(summary({ status: 'deleted', revision: 2 }));
      await deleting;
      expect(store.getState().conversations).toHaveLength(0);
      expect(store.getState().v2Transcripts).not.toHaveProperty(CONVERSATION_ID);
    });

    it('retries older history independently without closing a healthy subscribed socket', async () => {
      let pageAttempt = 0;
      const recovered = v2Message({ id: 'recovered-history', ordinal: 1 });
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ nextCursor: 'older-page' }),
        getMessagesV2Impl: async () => {
          pageAttempt += 1;
          if (pageAttempt === 1) throw new Error('temporary history failure');
          return { items: [recovered], nextCursor: null, throughSeq: 99 };
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      await openV2Conversation(store, scripted);
      expect(store.getState().connection).toBe('connected');
      expect(scripted.sockets[0].closed).toBe(false);
      expect(store.getState().v2Transcripts[CONVERSATION_ID].nextCursor).toBe('older-page');

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(2));
      expect(scripted.sockets).toHaveLength(1);
      expect(scripted.sockets[0].closed).toBe(false);
      expect(store.getState().v2Transcripts[CONVERSATION_ID].messages).toHaveProperty(recovered.id);
    });

    it('discards a page from a dropped socket generation and resumes history on reconnect', async () => {
      let resolveStalePage!: (page: MobileV2ConversationMessagePage) => void;
      const stalePage = new Promise<MobileV2ConversationMessagePage>((resolve) => {
        resolveStalePage = resolve;
      });
      let pageAttempt = 0;
      const { rest, getMessagesV2 } = fakeRest({
        bootstrapImpl: async () => v2Bootstrap({ nextCursor: 'shared-cursor' }),
        getMessagesV2Impl: async () => {
          pageAttempt += 1;
          if (pageAttempt === 1) return stalePage;
          return {
            items: [v2Message({ id: 'fresh-generation-history', ordinal: 1 })],
            nextCursor: null,
            throughSeq: 500,
          };
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(1));
      scripted.sockets[0].open();
      await vi.waitFor(() => expect(scripted.sockets[0].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 0);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(1));

      scripted.onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 1);
      await vi.waitFor(() => expect(getMessagesV2).toHaveBeenCalledTimes(2));

      resolveStalePage({
        items: [v2Message({ id: 'stale-generation-history', ordinal: 0 })],
        nextCursor: null,
        throughSeq: 999,
      });
      await opening;

      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      expect(transcript.messages).toHaveProperty('fresh-generation-history');
      expect(transcript.messages).not.toHaveProperty('stale-generation-history');
      expect(transcript.nextCursor).toBeNull();
    });

    it('coalesces concurrent revision-conflict refreshes and waits for resubscription', async () => {
      let resolveRefresh!: (value: MobileV2ConversationBootstrap) => void;
      const refresh = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolveRefresh = resolve;
      });
      let bootstrapCall = 0;
      const queued = pendingInput();
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1 ? v2Bootstrap({ pendingInputs: [queued] }) : refresh;
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      let editSettled = false;
      let removeSettled = false;
      const editing = store
        .getState()
        .editFollowUp(CONVERSATION_ID, queued.inputId, queued.revision, 'edited')
        .finally(() => {
          editSettled = true;
        });
      const removing = store
        .getState()
        .removeFollowUp(CONVERSATION_ID, queued.inputId, queued.revision)
        .finally(() => {
          removeSettled = true;
        });
      const commands = scripted.sockets[0].sent.filter(
        (frame) => frame.type === 'edit_follow_up' || frame.type === 'remove_follow_up',
      );
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        scripted.onFrames[0]({
          type: 'command_rejected',
          id: command.id,
          conversationId: CONVERSATION_ID,
          code: 'revision_conflict',
          error: 'stale projection',
          retryable: true,
        });
      }

      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      expect(editSettled).toBe(false);
      expect(removeSettled).toBe(false);
      resolveRefresh(
        v2Bootstrap({ pendingInputs: [pendingInput({ revision: 7 })], v2ThroughSeq: 7 }),
      );
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      expect(editSettled).toBe(false);
      expect(removeSettled).toBe(false);
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);

      await expect(editing).rejects.toMatchObject({ code: 'revision_conflict' });
      await expect(removing).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(bootstrap).toHaveBeenCalledTimes(2);
      expect(store.getState().connection).toBe('connected');
    });

    it('coalesces a burst of v2 gaps into one bootstrap refresh', async () => {
      let resolveRefresh!: (value: MobileV2ConversationBootstrap) => void;
      const refresh = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolveRefresh = resolve;
      });
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1 ? v2Bootstrap() : refresh;
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](inputFrame('input_accepted', 3, pendingInput({ inputId: 'gap-a' })));
      scripted.onFrames[0](inputFrame('input_accepted', 4, pendingInput({ inputId: 'gap-b' })));
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      expect(bootstrap).toHaveBeenCalledTimes(2);

      resolveRefresh(v2Bootstrap({ v2ThroughSeq: 4 }));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    });

    it('surfaces a rejected v2 cancel without terminalizing the active run or socket', async () => {
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({
            conversation: v2Summary({ activeTurnId: 'active-run', status: 'running' }),
          }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      store.getState().cancelTurn(CONVERSATION_ID);
      scripted.onFrames[0]({
        type: 'command_rejected',
        id: 'active-run',
        code: 'conversation_busy',
        error: 'The response already ended',
        retryable: false,
      });

      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      expect(transcript.error).toMatchObject({
        message: 'The response already ended',
        code: 'conversation_busy',
        retryable: false,
        activeTurnId: 'active-run',
      });
      expect(transcript.conversation.activeTurnId).toBe('active-run');
      expect(store.getState().connection).toBe('connected');
      expect(scripted.sockets[0].closed).toBe(false);
    });

    it('routes a missing-conversation rejection to a retained cancel before a same-id ordinary send', async () => {
      const { rest } = fakeRest({ bootstrapImpl: async () => v2Bootstrap() });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      let sendSettled = false;
      const sending = store
        .getState()
        .sendMessage(CONVERSATION_ID, 'ordinary send')
        .finally(() => {
          sendSettled = true;
        });
      const command = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'message' }> =>
          frame.type === 'message',
      );
      if (!command) throw new Error('expected message command');
      scripted.onFrames[0]({
        type: 'command_rejected',
        id: command.id,
        code: 'conversation_busy',
        error: 'legacy rejection without a current cancel',
        retryable: false,
      });
      await Promise.resolve();
      expect(sendSettled).toBe(false);
      expect(store.getState().connection).toBe('connected');

      store.setState((state) => {
        const transcript = state.v2Transcripts[CONVERSATION_ID];
        const conversation = {
          ...transcript.conversation,
          status: 'running' as const,
          activeTurnId: command.id,
        };
        return {
          conversations: [conversation],
          v2Transcripts: {
            ...state.v2Transcripts,
            [CONVERSATION_ID]: { ...transcript, conversation },
          },
        };
      });
      store.getState().cancelTurn(CONVERSATION_ID);

      scripted.onFrames[0]({
        type: 'command_rejected',
        id: command.id,
        code: 'conversation_busy',
        error: 'cancel arrived after completion',
        retryable: false,
      });
      await Promise.resolve();

      expect(sendSettled).toBe(false);
      expect(store.getState().connection).toBe('connected');
      expect(store.getState().v2Transcripts[CONVERSATION_ID].error).toMatchObject({
        message: 'cancel arrived after completion',
        activeTurnId: command.id,
      });

      scripted.onFrames[0](
        acceptedFrame(1, {
          id: command.id,
          runId: command.id,
          segmentTurnId: command.id,
        }),
      );
      await sending;
    });

    it('terminalizes a cancel rejection whose matching run id names another conversation', async () => {
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({
            conversation: v2Summary({ activeTurnId: 'active-run', status: 'running' }),
          }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      store.getState().cancelTurn(CONVERSATION_ID);
      scripted.onFrames[0]({
        type: 'command_rejected',
        id: 'active-run',
        conversationId: 'foreign-conversation',
        code: 'conversation_busy',
        error: 'foreign conversation correlation',
        retryable: false,
      });

      expect(store.getState().connection).toBe('offline');
      expect(scripted.sockets[0].closed).toBe(true);
    });

    it('does not let a delayed rename response rewind a newer active v2 lifecycle', async () => {
      let resolveRename!: (value: ConversationSummary) => void;
      const renameResponse = new Promise<ConversationSummary>((resolve) => {
        resolveRename = resolve;
      });
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({ conversation: v2Summary({ title: 'Original', revision: 7 }) }),
        patchConversationImpl: async () => renameResponse,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const renaming = store.getState().renameConversation(CONVERSATION_ID, 'Renamed');
      const sending = store.getState().sendMessage(CONVERSATION_ID, 'new active turn');
      const sent = scripted.sockets[0].sent.find(
        (frame): frame is Extract<MobileV2WsClientFrame, { type: 'message' }> =>
          frame.type === 'message',
      );
      if (!sent) throw new Error('expected v2 message command');
      scripted.onFrames[0](
        acceptedFrame(1, {
          id: sent.id,
          runId: sent.id,
          segmentTurnId: sent.id,
          revision: 9,
        }),
      );
      await sending;

      resolveRename(summary({ title: 'Renamed', revision: 8, status: 'idle', activeTurnId: null }));
      await renaming;

      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        title: 'Renamed',
        revision: 9,
        status: 'running',
        activeTurnId: sent.id,
      });
      expect(
        store.getState().conversations.find((item) => item.id === CONVERSATION_ID),
      ).toMatchObject({
        title: 'Renamed',
        revision: 9,
        status: 'running',
        activeTurnId: sent.id,
      });
    });

    it('ignores success and rollback from rename attempts superseded by a newer rename', async () => {
      let resolveFirst!: (value: ConversationSummary) => void;
      let rejectThird!: (error: Error) => void;
      const firstResponse = new Promise<ConversationSummary>((resolve) => {
        resolveFirst = resolve;
      });
      const thirdResponse = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectThird = reject;
      });
      const { rest } = fakeRest({
        conversationPage: { items: [summary({ title: 'Original' })], nextCursor: null },
        patchConversationImpl: async (_conversationId, patch) => {
          const requestedTitle = (patch as { title: string }).title;
          if (requestedTitle === 'First') return firstResponse;
          if (requestedTitle === 'Third') return thirdResponse;
          return summary({ title: requestedTitle, revision: requestedTitle === 'Second' ? 3 : 5 });
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const first = store.getState().renameConversation(CONVERSATION_ID, 'First');
      const second = store.getState().renameConversation(CONVERSATION_ID, 'Second');
      await second;
      resolveFirst(summary({ title: 'First', revision: 2 }));
      await first;
      expect(store.getState().conversations[0]).toMatchObject({ title: 'Second', revision: 3 });

      const third = store.getState().renameConversation(CONVERSATION_ID, 'Third');
      const fourth = store.getState().renameConversation(CONVERSATION_ID, 'Fourth');
      await fourth;
      rejectThird(new Error('older rename failed late'));
      await expect(third).rejects.toThrow('older rename failed late');
      expect(store.getState().conversations[0]).toMatchObject({ title: 'Fourth', revision: 5 });
    });

    it('uses an older successful title as the rollback baseline without rewinding newer v2 lifecycle', async () => {
      let resolveFirst!: (value: ConversationSummary) => void;
      let rejectSecond!: (error: Error) => void;
      const firstResponse = new Promise<ConversationSummary>((resolve) => {
        resolveFirst = resolve;
      });
      const secondResponse = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectSecond = reject;
      });
      let bootstrapCall = 0;
      const { rest } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1
            ? v2Bootstrap({ conversation: v2Summary({ title: 'Original', revision: 7 }) })
            : v2Bootstrap({
                conversation: v2Summary({
                  title: 'Original',
                  revision: 9,
                  status: 'running',
                  activeTurnId: 'live-run',
                  v2LastSeq: 2,
                }),
                v2ThroughSeq: 2,
              });
        },
        patchConversationImpl: async (_conversationId, patch) =>
          (patch as { title: string }).title === 'First' ? firstResponse : secondResponse,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const first = store.getState().renameConversation(CONVERSATION_ID, 'First');
      const second = store.getState().renameConversation(CONVERSATION_ID, 'Second');
      scripted.onFrames[0](inputFrame('input_accepted', 2, pendingInput()));
      await vi.waitFor(() => expect(bootstrapCall).toBe(2));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);

      resolveFirst(summary({ title: 'First', revision: 8 }));
      await first;
      rejectSecond(new Error('second rename failed'));
      await expect(second).rejects.toThrow('second rename failed');

      expect(store.getState().conversations[0]).toMatchObject({
        title: 'First',
        revision: 9,
        status: 'running',
        activeTurnId: 'live-run',
      });
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        title: 'First',
        revision: 9,
        status: 'running',
        activeTurnId: 'live-run',
      });
    });

    it('preserves a completed rename when an older bootstrap refresh resolves later', async () => {
      let resolveRefresh!: (value: MobileV2ConversationBootstrap) => void;
      const refresh = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolveRefresh = resolve;
      });
      let bootstrapCall = 0;
      const { rest } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1
            ? v2Bootstrap({ conversation: v2Summary({ title: 'Original', revision: 7 }) })
            : refresh;
        },
        patchConversationImpl: async () => summary({ title: 'Renamed', revision: 8 }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](inputFrame('input_accepted', 3, pendingInput()));
      await vi.waitFor(() => expect(bootstrapCall).toBe(2));
      await store.getState().renameConversation(CONVERSATION_ID, 'Renamed');
      resolveRefresh(
        v2Bootstrap({
          conversation: v2Summary({ title: 'Original', revision: 7, v2LastSeq: 3 }),
          v2ThroughSeq: 3,
        }),
      );
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );

      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        title: 'Renamed',
        revision: 8,
      });
      expect(store.getState().conversations[0]).toMatchObject({ title: 'Renamed', revision: 8 });
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
    });

    it('lets a bootstrap own sequenced lifecycle while preserving newer rename metadata', async () => {
      let resolveRefresh!: (value: MobileV2ConversationBootstrap) => void;
      const refresh = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolveRefresh = resolve;
      });
      let bootstrapCall = 0;
      const { rest } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1
            ? v2Bootstrap({
                conversation: v2Summary({
                  title: 'Original',
                  revision: 7,
                  status: 'running',
                  activeTurnId: 'old-run',
                  v2LastSeq: 1,
                }),
                v2ThroughSeq: 1,
              })
            : refresh;
        },
        patchConversationImpl: async () => summary({ title: 'Renamed', revision: 9 }),
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](inputFrame('input_accepted', 3, pendingInput()));
      await vi.waitFor(() => expect(bootstrapCall).toBe(2));
      await store.getState().renameConversation(CONVERSATION_ID, 'Renamed');
      resolveRefresh(
        v2Bootstrap({
          conversation: v2Summary({
            title: 'Original',
            revision: 8,
            status: 'idle',
            activeTurnId: null,
            v2LastSeq: 3,
          }),
          v2ThroughSeq: 3,
        }),
      );
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );

      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        title: 'Renamed',
        revision: 9,
        status: 'idle',
        activeTurnId: null,
        v2LastSeq: 3,
      });
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
    });

    it('keeps only an optimistic title over a newer bootstrap lifecycle', async () => {
      let resolveRename!: (value: ConversationSummary) => void;
      const renameResponse = new Promise<ConversationSummary>((resolve) => {
        resolveRename = resolve;
      });
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1
            ? v2Bootstrap({ conversation: v2Summary({ title: 'Original', revision: 7 }) })
            : v2Bootstrap({
                conversation: v2Summary({
                  title: 'Original',
                  revision: 9,
                  status: 'running',
                  activeTurnId: 'remote-run',
                  v2LastSeq: 2,
                }),
                v2ThroughSeq: 2,
              });
        },
        patchConversationImpl: async () => renameResponse,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const renaming = store.getState().renameConversation(CONVERSATION_ID, 'Renamed');
      scripted.onFrames[0](inputFrame('input_accepted', 2, pendingInput()));
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );

      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        title: 'Renamed',
        revision: 9,
        status: 'running',
        activeTurnId: 'remote-run',
      });
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
      resolveRename(summary({ title: 'Renamed', revision: 8 }));
      await renaming;
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toMatchObject({
        title: 'Renamed',
        revision: 9,
        status: 'running',
        activeTurnId: 'remote-run',
      });
    });

    it('rolls a failed rename back to a newer authoritative bootstrap title', async () => {
      let rejectRename!: (error: Error) => void;
      const renameResponse = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectRename = reject;
      });
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          return bootstrapCall === 1
            ? v2Bootstrap({ conversation: v2Summary({ title: 'Original', revision: 7 }) })
            : v2Bootstrap({
                conversation: v2Summary({
                  title: 'Remote title',
                  revision: 9,
                  status: 'running',
                  activeTurnId: 'remote-run',
                  v2LastSeq: 2,
                }),
                v2ThroughSeq: 2,
              });
        },
        patchConversationImpl: async () => renameResponse,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const renaming = store.getState().renameConversation(CONVERSATION_ID, 'Optimistic title');
      scripted.onFrames[0](inputFrame('input_accepted', 2, pendingInput()));
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      expect(store.getState().conversations[0].title).toBe('Optimistic title');
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);

      rejectRename(new Error('rename failed'));
      await expect(renaming).rejects.toThrow('rename failed');
      expect(store.getState().conversations[0]).toMatchObject({
        title: 'Remote title',
        revision: 9,
        status: 'running',
        activeTurnId: 'remote-run',
      });
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation.title).toBe(
        'Remote title',
      );
    });

    it('retries a required bootstrap while the same socket remains connected', async () => {
      const remoteAccepted = acceptedFrame(1, {
        id: 'remote-run',
        runId: 'remote-run',
        segmentTurnId: 'remote-segment',
        userMessageId: 'remote-user',
        assistantMessageId: 'remote-assistant',
        revision: 2,
      });
      const remoteUser = v2Message({
        id: remoteAccepted.userMessageId,
        turnId: remoteAccepted.segmentTurnId,
        runId: remoteAccepted.runId,
        role: 'user',
        content: { type: 'user', text: 'sent remotely' },
      });
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          if (bootstrapCall === 1) return v2Bootstrap();
          if (bootstrapCall === 2) throw new Error('temporary bootstrap failure');
          return v2Bootstrap({
            conversation: v2Summary({
              revision: remoteAccepted.revision,
              status: 'running',
              activeTurnId: remoteAccepted.runId,
              v2LastSeq: remoteAccepted.v2Seq,
            }),
            messages: [remoteUser],
            v2ThroughSeq: remoteAccepted.v2Seq,
          });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](remoteAccepted);
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(3));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);

      await vi.waitFor(() =>
        expect(store.getState().v2Transcripts[CONVERSATION_ID].messages).toHaveProperty(
          remoteAccepted.userMessageId,
        ),
      );
      expect(store.getState().connection).toBe('connected');
    });

    it('keeps the active conversation bootstrap retry when an unrelated row is deleted', async () => {
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          if (bootstrapCall === 1) return v2Bootstrap();
          if (bootstrapCall === 2) throw new Error('temporary bootstrap failure');
          return v2Bootstrap({ v2ThroughSeq: 1 });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);
      store.setState((state) => ({
        conversations: [v2Summary({ id: 'conv-a' }), ...state.conversations],
      }));

      scripted.onFrames[0](
        acceptedFrame(1, {
          id: 'remote-run',
          runId: 'remote-run',
          segmentTurnId: 'remote-segment',
          userMessageId: 'remote-user',
          assistantMessageId: 'remote-assistant',
        }),
      );
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));

      await store.getState().deleteConversation('conv-a');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);

      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(3));
      expect(scripted.sockets[0].closed).toBe(false);
    });

    it('retries a required bootstrap when its resubscribe send fails', async () => {
      let resolveRefresh!: (value: MobileV2ConversationBootstrap) => void;
      const heldRefresh = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolveRefresh = resolve;
      });
      const remoteAccepted = acceptedFrame(1, {
        id: 'remote-run',
        runId: 'remote-run',
        segmentTurnId: 'remote-segment',
        userMessageId: 'remote-user',
        assistantMessageId: 'remote-assistant',
        revision: 2,
      });
      const remoteUser = v2Message({
        id: remoteAccepted.userMessageId,
        turnId: remoteAccepted.segmentTurnId,
        runId: remoteAccepted.runId,
        role: 'user',
        content: { type: 'user', text: 'sent remotely' },
      });
      const canonical = v2Bootstrap({
        conversation: v2Summary({
          revision: remoteAccepted.revision,
          status: 'running',
          activeTurnId: remoteAccepted.runId,
          v2LastSeq: remoteAccepted.v2Seq,
        }),
        messages: [remoteUser],
        v2ThroughSeq: remoteAccepted.v2Seq,
      });
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          if (bootstrapCall === 1) return v2Bootstrap();
          if (bootstrapCall === 2) return heldRefresh;
          return canonical;
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](remoteAccepted);
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      scripted.sockets[0].sendShouldThrow = true;
      resolveRefresh(canonical);
      await vi.waitFor(() => expect(store.getState().connection).toBe('reconnecting'));
      scripted.sockets[0].sendShouldThrow = false;

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(3));
      await vi.waitFor(() =>
        expect(
          scripted.sockets[0].sent.filter((frame) => frame.type === 'subscribe_conversation'),
        ).toHaveLength(2),
      );
      acknowledgeSubscription(scripted, 0, CONVERSATION_ID, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
    });

    it('retains a remote-accepted bootstrap requirement across a retryable socket drop', async () => {
      let resolveAbandonedRefresh!: (value: MobileV2ConversationBootstrap) => void;
      const abandonedRefresh = new Promise<MobileV2ConversationBootstrap>((resolve) => {
        resolveAbandonedRefresh = resolve;
      });
      const remoteAccepted = acceptedFrame(1, {
        id: 'remote-run',
        runId: 'remote-run',
        segmentTurnId: 'remote-segment',
        userMessageId: 'remote-user',
        assistantMessageId: 'remote-assistant',
        revision: 2,
      });
      const remoteUser = v2Message({
        id: remoteAccepted.userMessageId,
        turnId: remoteAccepted.segmentTurnId,
        runId: remoteAccepted.runId,
        role: 'user',
        content: { type: 'user', text: 'sent from Mission Control' },
      });
      const remoteAssistant = v2Message({
        id: remoteAccepted.assistantMessageId,
        turnId: remoteAccepted.segmentTurnId,
        runId: remoteAccepted.runId,
        role: 'assistant',
        content: { type: 'assistant', events: [] },
      });
      let bootstrapCall = 0;
      const { rest, bootstrap } = fakeRest({
        bootstrapImpl: async () => {
          bootstrapCall += 1;
          if (bootstrapCall === 1) return v2Bootstrap();
          if (bootstrapCall === 2) return abandonedRefresh;
          return v2Bootstrap({
            conversation: v2Summary({
              activeTurnId: remoteAccepted.runId,
              status: 'running',
              revision: remoteAccepted.revision,
              v2LastSeq: remoteAccepted.v2Seq,
            }),
            messages: [remoteUser, remoteAssistant],
            v2ThroughSeq: remoteAccepted.v2Seq,
          });
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      scripted.onFrames[0](remoteAccepted);
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
      scripted.onCloses[0](RETRYABLE_ERROR_CLOSE);
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      resolveAbandonedRefresh(v2Bootstrap());
      await Promise.resolve();
      expect(bootstrap).toHaveBeenCalledTimes(3);

      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() => expect(scripted.sockets[1].sent).toHaveLength(1));
      acknowledgeSubscription(scripted, 1);
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
      expect(store.getState().v2Transcripts[CONVERSATION_ID].messages).toHaveProperty(
        remoteAccepted.userMessageId,
      );
    });

    it('restores the latest hidden v2 summary when an optimistic delete fails', async () => {
      let rejectDelete!: (error: Error) => void;
      const deleteResponse = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectDelete = reject;
      });
      const { rest } = fakeRest({ deleteConversationImpl: async () => deleteResponse });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const deleting = store.getState().deleteConversation(CONVERSATION_ID);
      scripted.onFrames[0](
        inputFrame('input_accepted', 1, pendingInput({ revision: 4 }), { queueRevision: 4 }),
      );
      rejectDelete(new Error('delete failed'));
      await expect(deleting).rejects.toThrow('delete failed');

      expect(store.getState().conversations[0]).toMatchObject({
        queueRevision: 4,
        pendingFollowUpCount: 1,
      });
      expect(store.getState().conversations[0]).toEqual(
        store.getState().v2Transcripts[CONVERSATION_ID].conversation,
      );
    });

    it('restores higher-revision delete metadata without reviving an older sequenced lifecycle', async () => {
      let rejectRetry!: (error: Error) => void;
      const retry = new Promise<ConversationSummary>((_resolve, reject) => {
        rejectRetry = reject;
      });
      let deleteCall = 0;
      const fresh = v2Summary({
        title: 'Newer REST metadata',
        revision: 10,
        status: 'running',
        activeTurnId: 'old-run',
        v2LastSeq: 5,
      });
      const { rest } = fakeRest({
        bootstrapImpl: async () =>
          v2Bootstrap({
            conversation: v2Summary({
              revision: 9,
              status: 'running',
              activeTurnId: 'old-run',
              v2LastSeq: 5,
            }),
            v2ThroughSeq: 5,
          }),
        deleteConversationImpl: async () => {
          deleteCall += 1;
          if (deleteCall === 1) throw new MobileApiError(409, 'revision_conflict');
          return retry;
        },
        getConversationImpl: async () => fresh,
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      const deleting = store.getState().deleteConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(deleteCall).toBe(2));
      scripted.onFrames[0](
        doneFrame(6, { runId: 'old-run', segmentTurnId: 'old-run', outcome: 'completed' }),
      );
      rejectRetry(new Error('delete retry failed'));
      await expect(deleting).rejects.toThrow('delete retry failed');

      expect(store.getState().conversations[0]).toMatchObject({
        title: 'Newer REST metadata',
        revision: 10,
        status: 'idle',
        activeTurnId: null,
        v2LastSeq: 6,
      });
      expect(store.getState().v2Transcripts[CONVERSATION_ID].conversation).toEqual(
        store.getState().conversations[0],
      );
    });

    it('routes a manual older-page 401 through terminal unauthorized teardown', async () => {
      const { rest } = fakeRest({
        getMessagesV2Impl: async () => {
          throw new MobileApiError(401, 'unauthorized');
        },
      });
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);
      const transcript = store.getState().v2Transcripts[CONVERSATION_ID];
      store.setState({
        v2Transcripts: {
          ...store.getState().v2Transcripts,
          [CONVERSATION_ID]: { ...transcript, nextCursor: 'older' },
        },
      });

      await expect(store.getState().loadOlderMessages(CONVERSATION_ID)).resolves.toBeUndefined();
      expect(store.getState().connection).toBe('unauthorized');
      expect(scripted.sockets[0].closed).toBe(true);
    });

    it('surfaces an exact protocol close, rejects commands, and disables reconnect', async () => {
      const { rest } = fakeRest({});
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);
      const command = store.getState().enqueueInput(CONVERSATION_ID, 'followUp', 'later');

      scripted.onCloses[0]({
        kind: 'protocol',
        code: 1002,
        reason: 'invalid_frame',
        retryable: false,
      });

      await expect(command).rejects.toThrow('invalid_frame');
      expect(store.getState().connection).toBe('offline');
      expect(store.getState().v2Transcripts[CONVERSATION_ID].error?.message).toBe('invalid_frame');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 4);
      expect(scripted.sockets).toHaveLength(1);
    });

    it('treats a 4001 socket close as terminal unauthorized', async () => {
      const { rest } = fakeRest({});
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);
      const command = store.getState().enqueueInput(CONVERSATION_ID, 'followUp', 'later');

      scripted.onCloses[0]({
        kind: 'closed',
        code: 4001,
        reason: 'Unauthorized',
        retryable: true,
      });

      await expect(command).rejects.toThrow('Unauthorized');
      expect(store.getState().connection).toBe('unauthorized');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 4);
      expect(scripted.sockets).toHaveLength(1);
    });
  });
});
