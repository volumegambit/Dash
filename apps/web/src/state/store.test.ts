import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  MobileAgentEvent,
  MobileWsClientFrame,
  MobileWsServerFrame,
  SubagentListEntry,
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
import { groupSubagentEvents } from '../ui/blocks/subagents';
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
    kind: 'user',
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
type TestTurnFrame = Exclude<
  TestClientFrame,
  {
    type: 'subscribe' | 'unsubscribe' | 'subscribe_conversation';
  }
>;

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

  /** Frames excluding the `subscribe`/`unsubscribe` bookkeeping the store now
   * sends on every connect and conversation switch (task C7) — this is the
   * turn traffic a test means when it asserts on "what was sent". */
  get turnFrames(): TestTurnFrame[] {
    return this.sent.filter(
      (frame): frame is TestTurnFrame =>
        frame.type !== 'subscribe' &&
        frame.type !== 'unsubscribe' &&
        frame.type !== 'subscribe_conversation',
    );
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
  onCloses: Array<(close: ChatSocketClose | 'error') => void>;
}

function scriptedSocketFactory(): ScriptedFactory {
  const sockets: ScriptedChatSocket[] = [];
  const onFrames: FrameHandler[] = [];
  const onCloses: Array<(close: ChatSocketClose | 'error') => void> = [];
  const factory = vi.fn((onFrame: FrameHandler, onClose: (close: ChatSocketClose) => void) => {
    const socket = new ScriptedChatSocket();
    sockets.push(socket);
    onFrames.push(onFrame);
    onCloses.push((close) =>
      onClose(close === 'error' ? { kind: 'error', retryable: true } : close),
    );
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
  resumeSubagent: ReturnType<typeof vi.fn>;
  listSubagents: ReturnType<typeof vi.fn>;
  stopSubagent: ReturnType<typeof vi.fn>;
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
  /** Override for `rest.resumeSubagent()` — used by the `sendToSubagent` tests. */
  resumeSubagentImpl?: (childId: string, message: string, requestId?: string) => Promise<unknown>;
  /** Override for `rest.listSubagents()` — used by the tasks-panel (D3) tests. */
  listSubagentsImpl?: (conversationId: string) => Promise<{ subagents: SubagentListEntry[] }>;
  /** Override for `rest.stopSubagent()` — used by the tasks-panel (D3) tests. */
  stopSubagentImpl?: (subagentId: string) => Promise<unknown>;
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
  const resumeSubagent = vi.fn(
    opts.resumeSubagentImpl ??
      (async () => ({ ok: true, status: 'running', mode: 'queued' as const })),
  );
  const listSubagents = vi.fn(opts.listSubagentsImpl ?? (async () => ({ subagents: [] })));
  const stopSubagent = vi.fn(
    opts.stopSubagentImpl ?? (async () => ({ ok: true, status: 'cancelled' as const })),
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
    resumeSubagent,
    listSubagents,
    stopSubagent,
  } as unknown as MobileRestClient;
  return {
    rest,
    resumeSubagent,
    listSubagents,
    stopSubagent,
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

      expect(sockets[0].turnFrames).toHaveLength(1);
      const sent = sockets[0].turnFrames[0];
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

      const sent = sockets[0].turnFrames[0] as { location?: Record<string, unknown> };
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
      expect(sockets[0].turnFrames[0]).toMatchObject({ type: 'message', text: '', images });
    });

    it('omits the images field from the frame and the optimistic message when none are attached', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'text only');

      expect('images' in (sockets[0].turnFrames[0] as object)).toBe(false);
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

      expect(socket.turnFrames).toHaveLength(0);
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
      expect(sockets[0].turnFrames).toHaveLength(1);
      expect(sockets[0].turnFrames[0]).toMatchObject({ type: 'message', text: 'Hello' });
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
      expect(sockets[0].turnFrames[0]).toMatchObject({ type: 'message', text: 'Edited text' });
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
      expect(sockets[0].turnFrames).toHaveLength(0);
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
      expect(sockets[0].turnFrames).toHaveLength(0);
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
      expect(sockets[0].turnFrames).toHaveLength(0);
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
      const turnId = sockets[0].turnFrames[0].id;

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
      const turnId = sockets[0].turnFrames[0].id;
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
      const turnId = sockets[0].turnFrames[0].id;
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
      const turnId = sockets[0].turnFrames[0].id;
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
      const turnId = sockets[0].turnFrames[0].id;
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
      const turnId = sockets[0].turnFrames[0].id;
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
      const turnId = sockets[0].turnFrames[0].id;
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

      expect(sockets[0].turnFrames).toContainEqual({ type: 'cancel', id: turnId });
    });

    it('is a no-op before any turn has been accepted (no pending turnId yet)', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().cancelTurn(CONVERSATION_ID);

      expect(sockets[0].turnFrames).toHaveLength(0);
    });

    it('is a no-op for a conversation id other than the one the live socket is attached to', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');
      const turnId = sockets[0].turnFrames[0].id;
      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'real-user-msg-id',
        assistantMessageId: 'real-assistant-msg-id',
        revision: 2,
        seq: 1,
      });

      const sentBefore = sockets[0].turnFrames.length;
      store.getState().cancelTurn('some-other-conversation');

      expect(sockets[0].turnFrames).toHaveLength(sentBefore);
      expect(sockets[0].turnFrames.some((frame) => frame.type === 'cancel')).toBe(false);
    });

    it('logs and swallows a cancel send failure instead of throwing (stop button stays until a real done/error frame lands)', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createTestStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendMessage(CONVERSATION_ID, 'hello there');
      const turnId = sockets[0].turnFrames[0].id;
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

      expect(sockets[1].turnFrames).toHaveLength(1);
      expect(sockets[1].turnFrames[0]).toMatchObject({
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
      expect(sockets[1].turnFrames).toEqual([expectedResumeFrame]);
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
  });

  /**
   * Task C7 (sub-agents design 7.6): the gateway can start a turn on its own
   * to deliver a background child's completion notification, and fans it out
   * to per-conversation subscribers. These cover the client half — the
   * subscription itself, and rendering a turn this client never started.
   */
  describe('conversation subscriptions (C7)', () => {
    function subscriptionFrames(socket: ScriptedChatSocket): MobileWsClientFrame[] {
      return socket.sent.filter((f) => f.type === 'subscribe' || f.type === 'unsubscribe');
    }

    it('subscribes to the open conversation once the socket connects', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });

      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      await vi.waitFor(() =>
        expect(subscriptionFrames(socket)).toEqual([
          {
            type: 'subscribe',
            id: expect.any(String),
            agentId: 'agent-01',
            conversationId: CONVERSATION_ID,
          },
        ]),
      );
    });

    it('reports connected without waiting for the subscription round trip', async () => {
      // Deep-link path: the conversation list is not loaded, so
      // `resolveAgentId` does a REST call. Blocking the connected transition
      // on it would leave the composer disabled — and `sendMessage` throwing
      // — for the length of a request that has nothing to do with the socket.
      let releaseList: (() => void) | undefined;
      const listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      const { rest } = fakeRest({
        listConversationsImpl: async () => {
          await listGate;
          return { items: [summary()], nextCursor: null };
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });

      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      expect(store.getState().connection).toBe('connected');
      expect(subscriptionFrames(socket)).toEqual([]);

      releaseList?.();
      await vi.waitFor(() =>
        expect(subscriptionFrames(socket)).toEqual([
          {
            type: 'subscribe',
            id: expect.any(String),
            agentId: 'agent-01',
            conversationId: CONVERSATION_ID,
          },
        ]),
      );
    });

    it('unsubscribes the conversation it is leaving when switching to another one', async () => {
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2' })],
          nextCursor: null,
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const first = await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(subscriptionFrames(first)).toHaveLength(1));
      const second = await openAndConnect(store, sockets, 'conv-2');
      await vi.waitFor(() => expect(subscriptionFrames(second)).toHaveLength(1));

      expect(subscriptionFrames(first)).toEqual([
        {
          type: 'subscribe',
          id: expect.any(String),
          agentId: 'agent-01',
          conversationId: CONVERSATION_ID,
        },
        {
          type: 'unsubscribe',
          id: expect.any(String),
          agentId: 'agent-01',
          conversationId: CONVERSATION_ID,
        },
      ]);
      expect(subscriptionFrames(second)).toEqual([
        {
          type: 'subscribe',
          id: expect.any(String),
          agentId: 'agent-01',
          conversationId: 'conv-2',
        },
      ]);
    });

    it('re-subscribes over the fresh socket after a reconnect', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(sockets.length).toBe(2));
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));

      expect(subscriptionFrames(sockets[1])).toEqual([
        {
          type: 'subscribe',
          id: expect.any(String),
          agentId: 'agent-01',
          conversationId: CONVERSATION_ID,
        },
      ]);
    });

    it("ignores an older gateway's rejection of the subscribe frame instead of showing an outage", async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(subscriptionFrames(socket)).toHaveLength(1));
      const subscribe = subscriptionFrames(socket)[0];

      // Exactly what a pre-`subscribe` gateway answers: `parseChatClientFrame`
      // does not know the type, so it echoes the frame's own id back as a
      // validation error (apps/gateway/src/chat-ws.ts).
      onFrames[0]({
        type: 'error',
        id: subscribe.id,
        conversationId: CONVERSATION_ID,
        error: 'Invalid message: missing required fields',
        code: 'validation_failed',
        retryable: false,
      });

      expect(store.getState().transcripts[CONVERSATION_ID]?.error ?? null).toBeNull();
      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.status).not.toBe(
        'interrupted',
      );
      expect(store.getState().connection).toBe('connected');
    });
  });

  describe('protocol 2 conversation state (continued)', () => {
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

  describe('conversation subscriptions (C7 continued)', () => {
    function subscriptionFrames(socket: ScriptedChatSocket): MobileWsClientFrame[] {
      return socket.sent.filter(
        (frame) => frame.type === 'subscribe' || frame.type === 'unsubscribe',
      );
    }

    it('scopes the ignored-error ids to the socket that sent them', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onFrames, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const first = await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(subscriptionFrames(first)).toHaveLength(1));
      const staleId = subscriptionFrames(first)[0].id;

      onCloses[0]('error');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(sockets.length).toBe(2));
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
      await vi.waitFor(() => expect(subscriptionFrames(sockets[1])).toHaveLength(1));

      // The dead socket's ids are gone, so a collision cannot silently
      // swallow a real error frame on the new one.
      onFrames[1]({
        type: 'error',
        id: staleId,
        conversationId: CONVERSATION_ID,
        error: 'Agent exploded',
        code: 'validation_failed',
        retryable: false,
      });

      expect(store.getState().transcripts[CONVERSATION_ID].error?.message).toBe('Agent exploded');
    });

    it('still surfaces a genuine error frame for a real turn', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onFrames[0]({
        type: 'error',
        id: 'turn-1',
        conversationId: CONVERSATION_ID,
        error: 'Agent exploded',
        code: 'validation_failed',
        retryable: false,
      });

      expect(store.getState().transcripts[CONVERSATION_ID].error?.message).toBe('Agent exploded');
    });

    it('unsubscribes before tearing the socket down on dispose()', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(subscriptionFrames(socket)).toHaveLength(1));

      store.getState().dispose();

      expect(subscriptionFrames(socket).at(-1)).toMatchObject({
        type: 'unsubscribe',
        conversationId: CONVERSATION_ID,
      });
      expect(socket.closed).toBe(true);
    });
  });

  /**
   * Task C7: a turn the gateway started on its own (`accepted` carrying
   * `origin: 'notification'`) for a turn id this client never issued. Before
   * C7 the reconcile matched on `m.turnId === frame.id`, found nothing, and
   * left the assistant reply hanging with no user row at all.
   */
  describe('server-initiated turns (C7)', () => {
    const NOTIFICATION_TURN = 'turn-notification-1';

    async function deliverNotificationTurn(
      store: ReturnType<typeof createWebAppStore>,
      onFrame: FrameHandler,
    ) {
      onFrame({
        type: 'accepted',
        id: NOTIFICATION_TURN,
        conversationId: CONVERSATION_ID,
        userMessageId: 'notif-user-1',
        assistantMessageId: 'notif-assistant-1',
        revision: 4,
        seq: 7,
        origin: 'notification',
        kind: 'user',
      });
      onFrame({
        type: 'event',
        id: NOTIFICATION_TURN,
        conversationId: CONVERSATION_ID,
        seq: 8,
        event: { type: 'text_delta', text: 'The child finished.' },
      });
      onFrame({
        type: 'done',
        id: NOTIFICATION_TURN,
        conversationId: CONVERSATION_ID,
        seq: 9,
        outcome: 'completed',
      });
      await vi.waitFor(() =>
        expect(store.getState().transcripts[CONVERSATION_ID]?.streaming).toBeNull(),
      );
    }

    it('materialises the notification user row and attaches the assistant reply to it', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await deliverNotificationTurn(store, onFrames[0]);

      const messages = store.getState().transcripts[CONVERSATION_ID].messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: 'notif-user-1',
        turnId: NOTIFICATION_TURN,
        role: 'user',
        origin: 'notification',
      });
      expect(messages[1]).toMatchObject({
        id: 'notif-assistant-1',
        turnId: NOTIFICATION_TURN,
        role: 'assistant',
        status: 'completed',
        origin: 'notification',
      });
      expect(messages[1].content).toEqual({
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'The child finished.' }],
      });
    });

    it("refreshes the transcript when a server-initiated turn finishes, so the row shows the notification's own summary", async () => {
      const notificationText = [
        '[SYSTEM NOTIFICATION - NOT USER INPUT]',
        '',
        '<task-notification>',
        '<summary>Agent "Map gateway internals" finished</summary>',
        '</task-notification>',
      ].join('\n');
      const replayed = message({
        id: 'notif-user-1',
        turnId: NOTIFICATION_TURN,
        ordinal: 1,
        role: 'user',
        origin: 'notification',
        content: { type: 'user', text: notificationText },
      });
      let page: ConversationMessagePage = { items: [], nextCursor: null, throughSeq: 0 };
      const { rest, getMessages } = fakeRest({ getMessagesImpl: async () => page });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      const replayCalls = getMessages.mock.calls.length;
      // The gateway only has the row once the turn it belongs to has run.
      page = { items: [replayed], nextCursor: null, throughSeq: 9 };

      await deliverNotificationTurn(store, onFrames[0]);

      await vi.waitFor(() =>
        expect(
          store
            .getState()
            .transcripts[CONVERSATION_ID].messages.find((m) => m.id === 'notif-user-1')?.content,
        ).toEqual({ type: 'user', text: notificationText }),
      );
      expect(getMessages.mock.calls.length).toBeGreaterThan(replayCalls);
    });

    it('does not refetch the transcript when an ordinary user turn finishes', async () => {
      const { rest, getMessages } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await store.getState().sendMessage(CONVERSATION_ID, 'Hello');
      const turnId = sockets[0].turnFrames[0].id;
      const replayCalls = getMessages.mock.calls.length;

      onFrames[0]({
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        revision: 2,
        seq: 1,
      });
      onFrames[0]({
        type: 'done',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq: 2,
        outcome: 'completed',
      });

      await vi.waitFor(() =>
        expect(store.getState().transcripts[CONVERSATION_ID]?.streaming).toBeNull(),
      );
      expect(getMessages.mock.calls.length).toBe(replayCalls);
    });

    it('never fabricates a user row for an ordinary turn whose accepted carries no origin', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onFrames[0]({
        type: 'accepted',
        id: 'turn-from-a-peer',
        conversationId: CONVERSATION_ID,
        userMessageId: 'peer-user-1',
        assistantMessageId: 'peer-assistant-1',
        revision: 4,
        seq: 7,
      });

      await vi.waitFor(() =>
        expect(store.getState().transcripts[CONVERSATION_ID]?.pending?.turnId).toBe(
          'turn-from-a-peer',
        ),
      );
      expect(store.getState().transcripts[CONVERSATION_ID].messages).toEqual([]);
    });

    it('refuses to resend a notification row (its text is a system notification, not user input)', async () => {
      const notification = message({
        id: 'notif-user-1',
        turnId: NOTIFICATION_TURN,
        role: 'user',
        origin: 'notification',
        content: { type: 'user', text: '[SYSTEM NOTIFICATION - NOT USER INPUT]' },
      });
      const { rest } = fakeRest({
        messagePages: [{ items: [notification], nextCursor: null, throughSeq: 9 }],
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      const sent = await store.getState().resendFromMessage(CONVERSATION_ID, 'notif-user-1');

      expect(sent).toBe(false);
      expect(socket.turnFrames).toHaveLength(0);
      expect(store.getState().transcripts[CONVERSATION_ID].messages).toHaveLength(1);
    });
  });
  /**
   * Task D2: the web sub-agent row expands into the child's own conversation
   * (design §8.3) — a REST replay of the child transcript, a WS subscription
   * so it streams live, and a composer that sends a user turn INTO the child.
   */
  describe('sub-agent child conversations (D2)', () => {
    const CHILD_ID = 'child-1';

    type SubscriptionFrame = Extract<MobileWsClientFrame, { type: 'subscribe' | 'unsubscribe' }>;

    function subscriptionFrames(socket: ScriptedChatSocket): SubscriptionFrame[] {
      return socket.sent.filter(
        (f): f is SubscriptionFrame => f.type === 'subscribe' || f.type === 'unsubscribe',
      );
    }

    function childSummary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
      return summary({
        id: CHILD_ID,
        kind: 'subagent',
        parentConversationId: CONVERSATION_ID,
        subagent: {
          type: 'Explore',
          status: 'running',
          description: 'Map gateway internals',
          prompt: 'Find every websocket entry point',
          model: 'sonnet',
          background: false,
          depth: 1,
          startedAt: '2026-09-04T10:00:00.000Z',
          toolCallCount: 3,
          oneShot: true,
        },
        ...overrides,
      });
    }

    it("replays the child's transcript and records its SubagentInfo", async () => {
      const childMessage = message({
        id: 'child-msg-1',
        conversationId: CHILD_ID,
        turnId: 'child-turn-1',
        role: 'assistant',
        content: { type: 'assistant', events: [{ type: 'text_delta', text: 'Found them.' }] },
      });
      const { rest, getMessages, getConversation } = fakeRest({
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [childMessage] : [],
          nextCursor: null,
          throughSeq: 3,
        }),
        getConversationImpl: async (conversationId: string) =>
          conversationId === CHILD_ID ? childSummary() : summary(),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().loadSubagentTranscript(CHILD_ID);

      expect(getMessages).toHaveBeenCalledWith(CHILD_ID);
      expect(getConversation).toHaveBeenCalledWith(CHILD_ID);
      expect(store.getState().transcripts[CHILD_ID].messages).toEqual([childMessage]);
      expect(store.getState().subagents[CHILD_ID].facts).toMatchObject({ oneShot: true });
      // The parent transcript is untouched by a child replay.
      expect(store.getState().transcripts[CONVERSATION_ID].messages).toEqual([]);
    });

    it('still replays the transcript when the child summary fetch fails', async () => {
      const childMessage = message({ id: 'child-msg-1', conversationId: CHILD_ID });
      const { rest } = fakeRest({
        getMessagesImpl: async () => ({ items: [childMessage], nextCursor: null, throughSeq: 1 }),
        getConversationImpl: async () => {
          throw new Error('boom');
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await expect(store.getState().loadSubagentTranscript(CHILD_ID)).resolves.toBeUndefined();

      expect(store.getState().transcripts[CHILD_ID].messages).toEqual([childMessage]);
      expect(store.getState().subagents[CHILD_ID]?.facts).toBeUndefined();
    });

    it("subscribes to the child on the parent's agent, once, and unsubscribes on request", async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      await vi.waitFor(() =>
        expect(
          subscriptionFrames(socket).filter((f) => f.conversationId === CHILD_ID),
        ).toHaveLength(1),
      );
      expect(subscriptionFrames(socket).find((f) => f.conversationId === CHILD_ID)).toMatchObject({
        type: 'subscribe',
        agentId: 'agent-01',
      });

      store.getState().unsubscribeSubagent(CHILD_ID);
      // The wire frame is deferred by one microtask so a remount never drops
      // the watcher — see "sends no unsubscribe frame ..." below.
      await Promise.resolve();
      expect(subscriptionFrames(socket).at(-1)).toMatchObject({
        type: 'unsubscribe',
        conversationId: CHILD_ID,
      });
    });

    it('uses a separate capable-v2 socket for an expanded child and routes its run frames', async () => {
      const { rest } = fakeRest({});
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      const parentSocket = await openV2Conversation(store, scripted);

      store.getState().subscribeSubagent(CHILD_ID);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      const childSocket = scripted.sockets[1];
      childSocket.open();
      await vi.waitFor(() =>
        expect(
          childSocket.sent.some(
            (frame) => frame.type === 'subscribe_conversation' && frame.conversationId === CHILD_ID,
          ),
        ).toBe(true),
      );
      acknowledgeSubscription(scripted, 1, CHILD_ID);

      scripted.onFrames[1]({
        type: 'accepted',
        id: 'child-run',
        runId: 'child-run',
        segmentTurnId: 'child-segment',
        conversationId: CHILD_ID,
        v2Seq: 1,
        userMessageId: 'child-user',
        assistantMessageId: 'child-assistant',
        revision: 2,
      });

      expect(store.getState().transcripts[CHILD_ID]?.pending?.turnId).toBe('child-run');
      expect(
        parentSocket.sent.some(
          (frame) => frame.type === 'subscribe_conversation' && frame.conversationId === CHILD_ID,
        ),
      ).toBe(false);

      store.getState().unsubscribeSubagent(CHILD_ID);
      await Promise.resolve();
      expect(childSocket.closed).toBe(true);
      expect(parentSocket.closed).toBe(false);
    });

    it('reports a v2 child live only after its subscription acknowledgement', async () => {
      const { rest } = fakeRest({});
      const scripted = scriptedSocketFactory();
      const store = createTestStore({
        protocol: V2_PROTOCOL,
        rest,
        socketFactory: scripted.factory,
      });
      await openV2Conversation(store, scripted);

      store.getState().subscribeSubagent(CHILD_ID);
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(false);

      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(2));
      scripted.sockets[1].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[1].sent.some(
            (frame) => frame.type === 'subscribe_conversation' && frame.conversationId === CHILD_ID,
          ),
        ).toBe(true),
      );
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(false);

      acknowledgeSubscription(scripted, 1, CHILD_ID);
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(true);

      scripted.onCloses[1]('error');
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(false);

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(scripted.sockets).toHaveLength(3));
      scripted.sockets[2].open();
      await vi.waitFor(() =>
        expect(
          scripted.sockets[2].sent.some(
            (frame) => frame.type === 'subscribe_conversation' && frame.conversationId === CHILD_ID,
          ),
        ).toBe(true),
      );
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(false);

      acknowledgeSubscription(scripted, 2, CHILD_ID);
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(true);
    });

    // Fix item 8: D1's fold explicitly supports one child split across two
    // persisted messages by crash-reconcile, so TWO rows can carry the same
    // `subagentId`. Without refcounting, the first row to collapse kills the
    // other row's live stream.
    it('refcounts child subscriptions so two rows sharing a child cannot cut each other off', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      store.getState().subscribeSubagent(CHILD_ID);
      await vi.waitFor(() =>
        expect(
          subscriptionFrames(socket).filter((f) => f.conversationId === CHILD_ID),
        ).toHaveLength(1),
      );

      store.getState().unsubscribeSubagent(CHILD_ID);
      await Promise.resolve();
      expect(
        subscriptionFrames(socket).filter(
          (f) => f.type === 'unsubscribe' && f.conversationId === CHILD_ID,
        ),
      ).toHaveLength(0);

      store.getState().unsubscribeSubagent(CHILD_ID);
      await Promise.resolve();
      expect(
        subscriptionFrames(socket).filter(
          (f) => f.type === 'unsubscribe' && f.conversationId === CHILD_ID,
        ),
      ).toHaveLength(1);
    });

    /**
     * Fix round 2 (F3). The tasks panel holds no subscription of its own, but
     * it is now the primary resume path and it is routinely used against a
     * child whose block IS expanded. Whether an optimistic row can ever be
     * reconciled turns on exactly one thing — whether this client holds a
     * subscription on that child, because that is what decides whether the
     * `accepted` echoing the row's id ever arrives. So the store exposes the
     * refcount it already keeps, and callers read it at submit time.
     *
     * The DESIRED refcount, not `activeChildSubscriptions`. Desired is written
     * synchronously by `subscribeSubagent` and is what the deferred release
     * re-checks; active lags a `resolveAgentId` round trip on the way up and
     * is cleared wholesale by `clearChildSubscriptions` on a reconnect, and
     * neither of those changes whether an `accepted` will reach this client.
     */
    it('reports whether a subscription is held for a child, following the refcount', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(false);

      store.getState().subscribeSubagent(CHILD_ID);
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(true);

      // Two holders, one release: still held. Same refcount the wire frames
      // follow, so the answer cannot drift from what is on the socket.
      store.getState().subscribeSubagent(CHILD_ID);
      store.getState().unsubscribeSubagent(CHILD_ID);
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(true);

      // The bookkeeping is immediate even though the wire frame is deferred:
      // a caller submitting in this tick must not be told it is still
      // subscribed just because the `unsubscribe` has not gone out yet.
      store.getState().unsubscribeSubagent(CHILD_ID);
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(false);
      await Promise.resolve();
      expect(store.getState().isSubagentSubscribed(CHILD_ID)).toBe(false);

      // A child that was never subscribed is not subscribed.
      expect(store.getState().isSubagentSubscribed('child-never-seen')).toBe(false);
    });

    // Fix round 2, C1. The refcount really does go 1 -> 0 -> 1 across the
    // ChatView subtree swap: `done` clears `streaming` and materialises the
    // finalized message in ONE `set()` (store.ts's frame handler +
    // assemble.ts's `done` case), so React removes the streaming subtree and
    // adds the `MessageRow` one in a single commit, running the removed
    // subtree's cleanup before the added subtree's setup. A synchronous
    // release therefore put a real `unsubscribe` on the wire — and the
    // gateway replays NOTHING on `subscribe` (chat-ws.ts:426-427), so
    // whatever the child emitted in the gap was gone for good. The wire frame
    // is deferred to a microtask that re-checks the refcount; the bookkeeping
    // is not.
    it('sends no unsubscribe frame when a row is released and re-taken in the same tick', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);
      const childFrames = () =>
        subscriptionFrames(socket).filter((f) => f.conversationId === CHILD_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      await vi.waitFor(() => expect(childFrames()).toHaveLength(1));

      // Exactly React's order inside one commit: the old instance's cleanup,
      // then the new instance's setup.
      store.getState().unsubscribeSubagent(CHILD_ID);
      store.getState().subscribeSubagent(CHILD_ID);
      await Promise.resolve();
      await Promise.resolve();

      // Nothing on the wire at all: no `unsubscribe`, and no redundant
      // re-`subscribe` either — the server-side watcher was never dropped.
      expect(childFrames()).toHaveLength(1);
      expect(childFrames()[0].type).toBe('subscribe');

      // A genuine collapse still releases it — one microtask later.
      store.getState().unsubscribeSubagent(CHILD_ID);
      expect(childFrames().filter((f) => f.type === 'unsubscribe')).toHaveLength(0);
      await Promise.resolve();
      expect(childFrames().filter((f) => f.type === 'unsubscribe')).toHaveLength(1);
    });

    // Fix item 1 (the redundant re-fetch half): the loaded set lives in the
    // store, not in a component that a remount throws away.
    it('replays a child transcript only once, however many rows ask for it', async () => {
      const { rest, getMessages } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      const before = getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length;

      await store.getState().loadSubagentTranscript(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);

      expect(getMessages.mock.calls.filter((c) => c[0] === CHILD_ID)).toHaveLength(before + 1);
    });

    // Fix item 9: the seam between D2's two halves. A child's frames must land
    // in the CHILD's transcript, which is what the expanded row renders.
    it("routes a child-addressed event frame into the child's own transcript", async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onFrames[0]({
        type: 'accepted',
        id: 'child-turn-1',
        conversationId: CHILD_ID,
        userMessageId: 'child-user-1',
        assistantMessageId: 'child-assistant-1',
        revision: 2,
        seq: 1,
        origin: 'parent',
      });
      onFrames[0]({
        type: 'event',
        id: 'child-turn-1',
        conversationId: CHILD_ID,
        seq: 2,
        event: { type: 'text_delta', text: 'Reading the gateway.' },
      });

      await vi.waitFor(() =>
        expect(store.getState().transcripts[CHILD_ID]?.streaming).toEqual({
          type: 'assistant',
          events: [{ type: 'text_delta', text: 'Reading the gateway.' }],
        }),
      );
      expect(store.getState().transcripts[CHILD_ID].messages).toHaveLength(1);
      expect(store.getState().transcripts[CHILD_ID].messages[0]).toMatchObject({
        role: 'user',
        origin: 'parent',
      });
      // The parent's transcript is untouched — no stray streaming slot on it.
      expect(store.getState().transcripts[CONVERSATION_ID]?.streaming ?? null).toBeNull();
    });

    it('tracks which rows are expanded so a remount cannot collapse them', () => {
      const { rest } = fakeRest({});
      const { factory } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });

      expect(store.getState().subagents[CHILD_ID]).toBeUndefined();
      store.getState().patchSubagent(CHILD_ID, { expanded: true });
      expect(store.getState().subagents[CHILD_ID].expanded).toBe(true);
      store.getState().patchSubagent(CHILD_ID, { expanded: false });
      expect(store.getState().subagents[CHILD_ID].expanded).toBe(false);
    });

    // Round 2, I-b. Nothing cleared this before, so re-opening a conversation
    // rendered every row the user had EVER opened already-expanded — two REST
    // calls and a `subscribe` frame each, on an open nobody asked for. The
    // previous conversation's open rows and half-typed drafts belong to it.
    it("drops every row's expansion and draft when the conversation changes", async () => {
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-01' })],
          nextCursor: null,
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      store.getState().patchSubagent(CHILD_ID, { expanded: true, draft: 'half a thought' });
      store.getState().patchSubagent(`group:${CHILD_ID}`, { expanded: false });

      await openAndConnect(store, sockets, 'conv-2');

      expect(store.getState().subagents).toEqual({});
    });

    /**
     * Fix round 4, ruling 4. `transcripts` is initialised once and was never
     * reset: `clearChildSubscriptions` dropped the subscriptions, the replay
     * cache and `subagents`, but left every child transcript in place. Every
     * residue that lives in one — a duplicated row, an orphaned local row, a
     * stale streaming ghost — therefore survived a conversation switch and
     * accumulated for the store's lifetime. Clearing them bounds the growth
     * and makes each of those recoverable by navigating away and back.
     *
     * The PARENT's transcript is deliberately kept: it is the conversation's
     * own history, re-read on open, and not this function's to discard.
     */
    it("drops every child's cached transcript when the conversation changes", async () => {
      const other = 'child-2';
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-01' })],
          nextCursor: null,
        },
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CONVERSATION_ID ? [message()] : [],
          nextCursor: null,
          throughSeq: 1,
        }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      // One child still expanded...
      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);
      // ...and one collapsed again, which leaves NO subscription and no
      // replay-cache entry behind to find its transcript by.
      store.getState().subscribeSubagent(other);
      await store.getState().loadSubagentTranscript(other);
      store.getState().unsubscribeSubagent(other);
      await Promise.resolve();
      expect(store.getState().transcripts[CHILD_ID]).toBeDefined();
      expect(store.getState().transcripts[other]).toBeDefined();

      await openAndConnect(store, sockets, 'conv-2');

      expect(store.getState().transcripts[CHILD_ID]).toBeUndefined();
      expect(store.getState().transcripts[other]).toBeUndefined();
      // The conversation the user left keeps its own history.
      expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toHaveLength(1);
    });

    /**
     * The leak the clear above would otherwise still have.
     * `childTranscriptIds` is the ONLY record of which `transcripts` entries
     * belong to children, and `clearChildSubscriptions` empties it. A
     * `fetchChildTranscript` still in flight at that moment writes its entry
     * back AFTER the await — recreating the very entry the switch deleted, now
     * with nothing left pointing at it. Unless the child re-registers
     * post-await it is unreachable by every future clear and survives for the
     * store's lifetime.
     */
    it('re-registers a child whose transcript fetch lands AFTER a conversation switch', async () => {
      let releaseChild!: () => void;
      const childRow = message({
        id: 'child-msg-1',
        conversationId: CHILD_ID,
        turnId: 'child-turn-1',
      });
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-01' })],
          nextCursor: null,
        },
        getMessagesImpl: async (conversationId: string) => {
          if (conversationId !== CHILD_ID) return { items: [], nextCursor: null, throughSeq: 1 };
          await new Promise<void>((resolve) => {
            releaseChild = resolve;
          });
          return { items: [childRow], nextCursor: null, throughSeq: 1 };
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      // In flight when the user navigates away: the fetch is started, the
      // switch clears the registry, and only then does the read land.
      const loading = store.getState().loadSubagentTranscript(CHILD_ID);
      await openAndConnect(store, sockets, 'conv-2');
      expect(store.getState().transcripts[CHILD_ID]).toBeUndefined();

      releaseChild();
      await loading;
      // Not vacuous: the write really does recreate the entry the switch removed.
      await vi.waitFor(() => expect(store.getState().transcripts[CHILD_ID]).toBeDefined());

      await openAndConnect(store, sockets, CONVERSATION_ID);

      expect(store.getState().transcripts[CHILD_ID]).toBeUndefined();
    });

    /**
     * D3, folded into the slice merge. `subagentInfo` was the ONE piece of
     * per-child state `clearChildSubscriptions` did not touch: the
     * subscriptions, the replay cache, the child transcripts and `subagentUi`
     * all went, and the recorded `SubagentInfo` for every child the user had
     * ever expanded stayed for the life of the store, growing with every
     * conversation they visited. It is per-conversation state by construction
     * — it is read off a CHILD of the conversation being left — so it belongs
     * with the rest of them.
     */
    it("drops every child's recorded facts when the conversation changes", async () => {
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-01' })],
          nextCursor: null,
        },
        getConversationImpl: async (conversationId: string) =>
          conversationId === CHILD_ID ? childSummary() : summary({ id: conversationId }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);
      expect(store.getState().subagents[CHILD_ID]?.facts).toBeDefined();

      await openAndConnect(store, sockets, 'conv-2');

      expect(store.getState().subagents[CHILD_ID]?.facts).toBeUndefined();
    });

    /**
     * D3, folded into the slice merge. `refreshMessages` is the one writer of
     * a child transcript that never registered what it wrote. It is fired
     * from the `done` branch of `handleFrame` for any turn the gateway
     * started (`origin: 'parent'` on a child is exactly that), and its write
     * lands one REST round trip later — long enough for a conversation switch
     * to have run `clearChildSubscriptions` in between. The switch empties
     * `childTranscriptIds`, so the recreated entry is invisible to every
     * future clear: it has no reader (the row that owned it is gone) and no
     * owner, and it survives for the life of the store.
     */
    it('does not recreate a child transcript after the conversation has moved on', async () => {
      let releaseChildRefresh!: () => void;
      const { rest } = fakeRest({
        conversationPage: {
          items: [
            summary(),
            summary({ id: 'conv-2', agentId: 'agent-01' }),
            summary({ id: 'conv-3', agentId: 'agent-01' }),
          ],
          nextCursor: null,
        },
        getMessagesImpl: async (conversationId: string) => {
          if (conversationId !== CHILD_ID) return { items: [], nextCursor: null, throughSeq: 1 };
          await new Promise<void>((resolve) => {
            releaseChildRefresh = resolve;
          });
          return {
            items: [message({ id: 'child-msg-1', conversationId: CHILD_ID })],
            nextCursor: null,
            throughSeq: 1,
          };
        },
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      store.getState().subscribeSubagent(CHILD_ID);

      // A turn the ORCHESTRATOR started on the child: `origin: 'parent'` is
      // what makes `done` fire the post-turn message re-read.
      onFrames[0]({
        type: 'accepted',
        id: 'child-turn-1',
        conversationId: CHILD_ID,
        userMessageId: 'child-user-1',
        assistantMessageId: 'child-asst-1',
        seq: 1,
        revision: 2,
        origin: 'parent',
      } as MobileWsServerFrame);
      onFrames[0]({
        type: 'done',
        id: 'child-turn-1',
        conversationId: CHILD_ID,
        turnId: 'child-turn-1',
        seq: 2,
      } as MobileWsServerFrame);

      // The re-read is in flight when the user navigates away.
      await openAndConnect(store, sockets, 'conv-2');
      expect(store.getState().transcripts[CHILD_ID]).toBeUndefined();

      releaseChildRefresh();
      // Flush the re-read's own promise chain rather than polling: a
      // `waitFor` on an absence passes on its first tick whether or not the
      // write ever landed, which would make this vacuous.
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().transcripts[CHILD_ID]).toBeUndefined();

      // And the entry is not merely late: a further switch proves nothing was
      // put back behind the registry's back either.
      await openAndConnect(store, sockets, 'conv-3');
      expect(store.getState().transcripts[CHILD_ID]).toBeUndefined();
    });

    it("does not let a child subscription clobber the parent's own", async () => {
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-01' })],
          nextCursor: null,
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      await vi.waitFor(() =>
        expect(
          subscriptionFrames(socket).filter((f) => f.conversationId === CHILD_ID),
        ).toHaveLength(1),
      );
      await openAndConnect(store, sockets, 'conv-2');

      // Leaving the parent drops the PARENT's subscription, not the child's.
      expect(
        subscriptionFrames(socket).filter(
          (f) => f.type === 'unsubscribe' && f.conversationId === CONVERSATION_ID,
        ),
      ).toHaveLength(1);
    });

    it('re-subscribes an expanded child after a reconnect', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      await vi.waitFor(() =>
        expect(
          subscriptionFrames(sockets[0]).filter((f) => f.conversationId === CHILD_ID),
        ).toHaveLength(1),
      );

      onCloses[0]('error');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(sockets.length).toBe(2));
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));

      await vi.waitFor(() =>
        expect(
          subscriptionFrames(sockets[1]).filter(
            (f) => f.type === 'subscribe' && f.conversationId === CHILD_ID,
          ),
        ).toHaveLength(1),
      );
    });

    // Fix item 7: re-subscribing is not enough. Nothing replays what the child
    // emitted while the socket was down — the parent resumes from `sinceSeq`,
    // the child has no such cursor — so the transcript is re-walked instead.
    it("re-reads an expanded child's transcript after a reconnect", async () => {
      const { rest, getMessages } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);
      const childReplays = getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length;
      expect(childReplays).toBe(1);

      onCloses[0]('error');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(sockets.length).toBe(2));
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));

      await vi.waitFor(() =>
        expect(getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length).toBe(
          childReplays + 1,
        ),
      );
    });

    /**
     * Fix round 3, ruling 2. Releasing a child's watcher is the moment its
     * cached transcript goes stale: the gateway replays nothing on the next
     * `subscribe` (`chat-ws.ts`, "Bookkeeping only: no acknowledgement
     * frame"), so everything the child emitted while the row was collapsed —
     * including its whole reply to a queued steer — exists only on the
     * server. `loadedChildTranscripts` used to hold the child anyway, so the
     * re-expansion read nothing and the reply was never fetched at all.
     */
    it('re-reads a collapsed-then-re-expanded child from REST', async () => {
      const { rest, getMessages } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);
      expect(getMessages.mock.calls.filter((c) => c[0] === CHILD_ID)).toHaveLength(1);

      // Collapse. The release is deferred to a microtask (see
      // `unsubscribeSubagent`), so let it run.
      store.getState().unsubscribeSubagent(CHILD_ID);
      await Promise.resolve();

      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);
      expect(getMessages.mock.calls.filter((c) => c[0] === CHILD_ID)).toHaveLength(2);
    });

    /**
     * Fix round 4, ruling 1 guard 1. The re-read above repairs `messages` and
     * nothing else, so a `done` missed while the row was collapsed leaves
     * `streaming`/`pending` holding a half-finished copy of the very reply
     * the re-read just landed — rendered by `ChildTranscript` as a live,
     * permanently-spinning bubble UNDER the finished one. Since `transcripts`
     * outlives the conversation it never cleared on its own.
     *
     * The summary is already fetched here, and a finished child reports
     * `activeTurnId: null` (`conversation-service-sqlite.ts` `finishTurn`
     * sets `status='idle', active_turn_id=NULL` in one statement).
     */
    async function streamThenCollapse(
      store: ReturnType<typeof createWebAppStore>,
      onFrame: (frame: MobileWsServerFrame) => void,
    ): Promise<void> {
      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);
      onFrame({
        type: 'accepted',
        id: 'child-turn-1',
        conversationId: CHILD_ID,
        userMessageId: 'server-user-1',
        assistantMessageId: 'server-assistant-1',
        revision: 2,
        seq: 1,
        origin: 'parent',
      });
      onFrame({
        type: 'event',
        id: 'child-turn-1',
        conversationId: CHILD_ID,
        seq: 2,
        event: { type: 'text_delta', text: 'half a rep' },
      });
      await vi.waitFor(() =>
        expect(store.getState().transcripts[CHILD_ID]?.streaming).not.toBeNull(),
      );
      // Collapse. The `done` is never delivered — the gateway replays nothing
      // on the next `subscribe`.
      store.getState().unsubscribeSubagent(CHILD_ID);
      await Promise.resolve();
    }

    const finalizedChildReply = message({
      id: 'server-assistant-1',
      conversationId: CHILD_ID,
      turnId: 'child-turn-1',
      ordinal: 2,
      role: 'assistant',
      status: 'completed',
      content: {
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'half a reply, then the rest' }],
      },
    });

    it("clears a child's stale stream when the re-read says its turn is over", async () => {
      const { rest } = fakeRest({
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [finalizedChildReply] : [],
          nextCursor: null,
          throughSeq: 3,
        }),
        getConversationImpl: async (conversationId: string) =>
          conversationId === CHILD_ID ? childSummary({ activeTurnId: null }) : summary(),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await streamThenCollapse(store, onFrames[0]);

      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);

      const transcript = store.getState().transcripts[CHILD_ID];
      expect(transcript.streaming).toBeNull();
      expect(transcript.pending).toBeUndefined();
      // ...and the finished reply the re-read landed is still intact.
      expect(transcript.messages.filter((m) => m.role === 'assistant')).toEqual([
        finalizedChildReply,
      ]);
    });

    /**
     * The FOURTH case, from the other half of the `Promise.allSettled`: the
     * two reads are independent requests, so `finishTurn` can land between
     * them. The messages page is then the server's mid-turn snapshot (the
     * assistant row at `status: 'streaming'`) while the summary already says
     * the turn is over. Clearing there costs the `done` its `pending`, and
     * with it `origin: 'parent'` — which is the ONLY thing that fires the
     * post-`done` re-read (`handleFrame`'s `finishingOrigin`). The row would
     * sit at the partial snapshot, marked completed, with nothing left to
     * fetch the rest of it.
     *
     * So the messages read has to agree: a row it still reports as
     * `streaming` means the turn was live when the page was built, and the
     * stream is left alone.
     */
    it('leaves the stream alone when the messages page still reports the turn streaming', async () => {
      const partial = message({
        id: 'server-assistant-1',
        conversationId: CHILD_ID,
        turnId: 'child-turn-1',
        ordinal: 2,
        role: 'assistant',
        status: 'streaming',
        content: { type: 'assistant', events: [{ type: 'text_delta', text: 'half a rep' }] },
      });
      const { rest, getMessages } = fakeRest({
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [partial] : [],
          nextCursor: null,
          throughSeq: 5,
        }),
        // The summary was served AFTER `finishTurn`; the messages page before it.
        getConversationImpl: async (conversationId: string) =>
          conversationId === CHILD_ID ? childSummary({ activeTurnId: null }) : summary(),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await streamThenCollapse(store, onFrames[0]);

      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);

      expect(store.getState().transcripts[CHILD_ID].pending?.turnId).toBe('child-turn-1');
      const before = getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length;

      // The `done` still finds its pending turn, so the child's completion
      // re-read fires and the partial row is replaced by the full one.
      onFrames[0]({
        type: 'done',
        id: 'child-turn-1',
        conversationId: CHILD_ID,
        seq: 11,
        outcome: 'completed',
      } as MobileWsServerFrame);
      await vi.waitFor(() =>
        expect(getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length).toBe(before + 1),
      );
    });

    /**
     * The third case, and the one the clear itself could have caused: the
     * summary is a SNAPSHOT taken before the fetch resolved, while `t.pending`
     * is read when the write lands. A turn that starts in between would be
     * compared against a summary that predates it and its live stream wiped.
     * So the clear also requires the pending turn to be the same one that was
     * pending when the fetch began.
     */
    it('leaves a turn that started DURING the re-read alone', async () => {
      let releaseSummary: (() => void) | null = null;
      let childSummaryCall = 0;
      const { rest } = fakeRest({
        getMessagesImpl: async () => ({ items: [], nextCursor: null, throughSeq: 3 }),
        // Only the RE-READ's child summary is held open — the first load (in
        // `streamThenCollapse`) and the parent's own summary resolve at once,
        // so nothing but the window under test depends on this test's timing.
        getConversationImpl: (conversationId: string) => {
          if (conversationId !== CHILD_ID) return Promise.resolve(summary());
          childSummaryCall += 1;
          if (childSummaryCall === 1) return Promise.resolve(childSummary({ activeTurnId: null }));
          return new Promise((resolve) => {
            releaseSummary = () => resolve(childSummary({ activeTurnId: null }));
          });
        },
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await streamThenCollapse(store, onFrames[0]);

      store.getState().subscribeSubagent(CHILD_ID);
      const reading = store.getState().loadSubagentTranscript(CHILD_ID);
      expect(releaseSummary).not.toBeNull();

      // A SECOND turn starts while the read is in flight — the summary about
      // to resolve knows nothing about it.
      onFrames[0]({
        type: 'accepted',
        id: 'child-turn-2',
        conversationId: CHILD_ID,
        userMessageId: 'server-user-2',
        assistantMessageId: 'server-assistant-2',
        revision: 4,
        seq: 9,
        origin: 'parent',
      });
      onFrames[0]({
        type: 'event',
        id: 'child-turn-2',
        conversationId: CHILD_ID,
        seq: 10,
        event: { type: 'text_delta', text: 'starting over' },
      });
      (releaseSummary as unknown as () => void)();
      await reading;

      const transcript = store.getState().transcripts[CHILD_ID];
      expect(transcript.pending?.turnId).toBe('child-turn-2');
      expect(transcript.streaming).toEqual({
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'starting over' }],
      });
    });

    // The other half of the guard: a child the server still reports as
    // RUNNING that turn keeps its live stream. `refreshChildTranscripts`
    // calls the same function on every reconnect, so a client that comes back
    // mid-turn must not have its partial wiped out from under it.
    it("leaves a child's stream alone when the server still reports that turn active", async () => {
      const { rest } = fakeRest({
        getMessagesImpl: async () => ({ items: [], nextCursor: null, throughSeq: 3 }),
        getConversationImpl: async (conversationId: string) =>
          conversationId === CHILD_ID ? childSummary({ activeTurnId: 'child-turn-1' }) : summary(),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await streamThenCollapse(store, onFrames[0]);

      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);

      const transcript = store.getState().transcripts[CHILD_ID];
      expect(transcript.streaming).toEqual({
        type: 'assistant',
        events: [{ type: 'text_delta', text: 'half a rep' }],
      });
      expect(transcript.pending?.turnId).toBe('child-turn-1');
    });

    // The mirror image, and the reason the delete is NOT also done in
    // `attemptReconnect`: that path re-reads every watched child EAGERLY
    // (`refreshChildTranscripts`, guarded on `loadedChildTranscripts.has`),
    // so dropping the entry there would make the refresh skip the very
    // children it exists for — and dropping it after would break the SECOND
    // reconnect. Two reconnects, two refreshes.
    it('re-reads an expanded child on every reconnect, not just the first', async () => {
      const { rest, getMessages } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().subscribeSubagent(CHILD_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);
      expect(getMessages.mock.calls.filter((c) => c[0] === CHILD_ID)).toHaveLength(1);

      for (const [index, expected] of [
        [0, 2],
        [1, 3],
      ] as const) {
        onCloses[index]('error');
        await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
        await vi.waitFor(() => expect(sockets.length).toBe(index + 2));
        sockets[index + 1].open();
        await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
        await vi.waitFor(() =>
          expect(getMessages.mock.calls.filter((c) => c[0] === CHILD_ID)).toHaveLength(expected),
        );
      }
    });

    // Fix items 2/6: a follow-up goes through `POST /subagents/:id/resume`,
    // never a WS `message` frame. Only the resume route reaches
    // `ChildHandle.answerQuestion` (the ONLY thing that unblocks a waiting
    // `ask_orchestrator`), and only it enforces the one-shot refusal, the
    // steer cap and the grant rebuild. A `message` frame goes to `hub.start`,
    // which either 409s `conversation_busy` against the child's turn lease or
    // opens a SECOND turn while the question stays blocked until timeout.
    it("resumes the child over REST rather than opening a turn on the child's conversation", async () => {
      const { rest, resumeSubagent } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      const socket = await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay', { optimistic: true });

      expect(resumeSubagent).toHaveBeenCalledWith(
        CHILD_ID,
        'also check the relay',
        expect.any(String),
      );
      expect(socket.turnFrames.filter((f) => f.type === 'message')).toHaveLength(0);
      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'user',
        conversationId: CHILD_ID,
        content: { type: 'user', text: 'also check the relay' },
      });
      expect(store.getState().transcripts[CONVERSATION_ID].messages).toHaveLength(0);
    });

    /**
     * Round-1 fix I2. The optimistic row only ever reconciles if this client
     * is SUBSCRIBED to the child — the `accepted` echoing its `requestId` is
     * the only correlation there is — and the tasks panel deliberately never
     * subscribes (it renders a list, not a transcript). A resume sent from a
     * panel row whose block has never been expanded therefore left the row
     * unreconciled forever: `mergeMessagesById` only deletes an existing row
     * when the incoming page carries its `turnId`, and the local row's
     * `turnId` is a client uuid the server never saw. The next expansion
     * showed the user's sentence TWICE.
     *
     * The row is now the caller's to ask for. A caller that renders no
     * transcript wants no row: nothing displays it, the composer's own error
     * line already reports a refusal, and there is no interleaving in which
     * it can duplicate.
     */
    it('writes no optimistic row for a caller that did not ask for one', async () => {
      const serverRow = message({
        id: 'server-user-row',
        conversationId: CHILD_ID,
        turnId: 'server-turn-1',
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'also check the relay' },
      });
      const { rest, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'resumed' }),
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [serverRow] : [],
          nextCursor: null,
          throughSeq: 9,
        }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      // The panel's call: no expansion, no subscription, no opt-in.
      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay');

      // Nothing rendered that transcript, so nothing was written to it — and
      // no correlation id was minted for a row that does not exist.
      expect(store.getState().transcripts[CHILD_ID]).toBeUndefined();
      expect(resumeSubagent).toHaveBeenCalledWith(CHILD_ID, 'also check the relay', undefined);

      // Now the user clicks the row to watch the reply. Before the fix this
      // is where the duplicate became visible.
      await store.getState().loadSubagentTranscript(CHILD_ID);

      const users = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('server-user-row');
    });

    /**
     * The other half of the same case: the transcript IS open and subscribed
     * when an UNCORRELATED resume lands — one with no local row to echo. That
     * is a resume issued by a PEER client, or by the gateway itself;
     * `reconcileAccepted` materialises the server's row and the replay `done`
     * triggers fills in its text. Still exactly one row.
     *
     * It stopped describing the tasks PANEL in round 2 (F3): the panel now
     * asks `isSubagentSubscribed`, so against an open block it opts in and
     * takes the reconciliation path above instead. The reason is exactly the
     * blank window this test's own shape exposes — between the `accepted` and
     * the replay the materialised row carries `content.text: ''`, which is
     * the right answer for a peer's sentence this client never had and the
     * wrong one for a sentence the user just typed here.
     */
    it('shows an uncorrelated resume once in a transcript that is already open', async () => {
      const serverRow = message({
        id: 'server-user-1',
        conversationId: CHILD_ID,
        turnId: 'server-turn-1',
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'also check the relay' },
      });
      const { rest, getMessages } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'resumed' }),
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [serverRow] : [],
          nextCursor: null,
          throughSeq: 9,
        }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      // The block is open: transcript loaded and child subscribed.
      await store.getState().loadSubagentTranscript(CHILD_ID);
      store.getState().subscribeSubagent(CHILD_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay');
      onFrames[0](childAccepted());
      onFrames[0]({
        type: 'done',
        id: 'server-turn-1',
        conversationId: CHILD_ID,
        seq: 8,
        outcome: 'completed',
      } as MobileWsServerFrame);
      await vi.waitFor(() =>
        expect(
          getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length,
        ).toBeGreaterThanOrEqual(2),
      );

      const users = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        id: 'server-user-1',
        content: { type: 'user', text: 'also check the relay' },
      });
    });

    /**
     * Fix round 2 (F3), and the property the whole ruling is about: with the
     * subscription held and the caller opting in, the user's sentence is in
     * the transcript BEFORE anything comes back — not after the `accepted`,
     * and not after the replay `done` triggers.
     *
     * Driven with the tasks panel's exact precondition (transcript loaded,
     * child subscribed, opt-in from a caller that renders no transcript of
     * its own), because that is the path the panel now takes and the previous
     * two tests do not cover it: the uncorrelated one above declines, and
     * `reconciles a resumed follow-up into ONE row carrying the server ids`
     * opts in without loading or subscribing and only asserts after the echo.
     * The blank `from orchestrator` row F3 reported is exactly this assertion
     * failing.
     */
    it('shows the text immediately when a subscribed caller opts in, then reconciles it', async () => {
      const serverRow = message({
        id: 'server-user-1',
        conversationId: CHILD_ID,
        turnId: 'server-turn-1',
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'also check the relay' },
      });
      // The child's row for THIS resume does not exist server-side until the
      // resume is made, so the first read (the block's own expansion) must
      // not already carry it.
      let resumed = false;
      const { rest, getMessages, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => {
          resumed = true;
          return { ok: true, status: 'running', mode: 'resumed' };
        },
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID && resumed ? [serverRow] : [],
          nextCursor: null,
          throughSeq: 9,
        }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      // The block is open: transcript loaded and child subscribed. The PANEL
      // is what sends, so it holds no subscription of its own — it asked the
      // store whether one was held and was told yes.
      await store.getState().loadSubagentTranscript(CHILD_ID);
      store.getState().subscribeSubagent(CHILD_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay', { optimistic: true });

      // Before the `accepted`. This is the window F3 measured as the whole
      // child turn — minutes, for a queued steer.
      const pending = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toEqual({ type: 'user', text: 'also check the relay' });

      onFrames[0](childAccepted({ requestId: resumeSubagent.mock.calls[0][2] as string }));
      onFrames[0]({
        type: 'done',
        id: 'server-turn-1',
        conversationId: CHILD_ID,
        seq: 8,
        outcome: 'completed',
      } as MobileWsServerFrame);
      await vi.waitFor(() =>
        expect(
          getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length,
        ).toBeGreaterThanOrEqual(2),
      );

      // And still exactly one row once the server's own copy has been read.
      const users = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        id: 'server-user-1',
        turnId: 'server-turn-1',
        content: { type: 'user', text: 'also check the relay' },
      });
    });

    /**
     * Fix round 2, C2. On the REST resume path the SERVER chooses the turn id,
     * so the optimistic row's client uuid matches neither `frame.id` nor
     * `frame.userMessageId` and `reconcileAccepted` materialised a SECOND row
     * for every follow-up. The store now records the local id per child and
     * hands it to `reconcileAccepted` when a `parent`-origin `accepted` lands.
     *
     * Three server paths, not the two the response's `mode` names:
     *  - `resumed` (finished child)          -> `accepted` almost immediately;
     *  - `queued` + steer (live child)       -> `accepted` when the current
     *    turn ends (`child-handle.ts` `beginTurn(steerQueue.shift())`);
     *  - `queued` + answer (waiting child)   -> NO `accepted`, ever: the text
     *    is the `ask_orchestrator` tool result inside the running turn.
     */
    function childAccepted(overrides: Partial<Record<string, unknown>> = {}): MobileWsServerFrame {
      return {
        type: 'accepted',
        id: 'server-turn-1',
        conversationId: CHILD_ID,
        userMessageId: 'server-user-1',
        assistantMessageId: 'server-assistant-1',
        revision: 3,
        seq: 7,
        origin: 'parent',
        ...overrides,
      } as MobileWsServerFrame;
    }

    it('reconciles a resumed follow-up into ONE row carrying the server ids', async () => {
      const serverRow = message({
        id: 'server-user-1',
        conversationId: CHILD_ID,
        turnId: 'server-turn-1',
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'also check the relay' },
      });
      const { rest, getMessages, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'resumed' }),
        // The child's REST replay, once the turn finishes.
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [serverRow] : [],
          nextCursor: null,
          throughSeq: 9,
        }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay', { optimistic: true });
      onFrames[0](childAccepted({ requestId: resumeSubagent.mock.calls[0][2] as string }));

      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'server-user-1',
        turnId: 'server-turn-1',
        role: 'user',
        origin: 'parent',
        status: 'completed',
        content: { type: 'user', text: 'also check the relay' },
      });

      // Deliberately NOT stopping at `accepted` — the review's probe showed the
      // duplicate only becomes visible to the user once the turn's `done`
      // triggers `refreshMessages` and the blank second row is filled with the
      // same sentence. `origin: 'parent'` on the pending turn is what makes
      // that refetch fire.
      onFrames[0]({
        type: 'done',
        id: 'server-turn-1',
        conversationId: CHILD_ID,
        seq: 8,
        outcome: 'completed',
      } as MobileWsServerFrame);
      await vi.waitFor(() =>
        expect(
          getMessages.mock.calls.filter((c) => c[0] === CHILD_ID).length,
        ).toBeGreaterThanOrEqual(1),
      );

      const afterReplay = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(afterReplay).toHaveLength(1);
      expect(afterReplay[0].id).toBe('server-user-1');
    });

    /**
     * Fix round 4, ruling 2 (round-3 review Minor 7, promoted). The echo can
     * arrive correctly and STILL orphan the local row: once a REST read has
     * merged the server's own user row, that row satisfies
     * `reconcileAccepted`'s FIRST branch (`m.turnId === frame.id`), which
     * returns before the `requestId` branch is ever reached. The local row is
     * then stranded exactly as if the `accepted` had been missed.
     *
     * The realistic interleaving is `attemptReconnect`, which fires
     * `refreshChildTranscripts()` while `flushChildSubscriptions` is still
     * awaiting `resolveAgentId` — the REST read and the subscribe are
     * genuinely concurrent there.
     *
     * Moving the `requestId` branch ahead of case 1 does NOT fix it: it would
     * adopt the local row to an id the server row already holds, producing two
     * rows with the same id (and a duplicate React key). The local row has to
     * be DROPPED and the server row left to stand.
     */
    it('drops the local row when the server row for its turn was merged first', async () => {
      const serverRow = message({
        id: 'server-user-1',
        conversationId: CHILD_ID,
        turnId: 'server-turn-1',
        ordinal: 4,
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'also check the relay' },
      });
      const { rest, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'queued' }),
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [serverRow] : [],
          nextCursor: null,
          throughSeq: 9,
        }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay', { optimistic: true });
      // The REST read wins the race and merges the server's row first.
      await store.getState().loadSubagentTranscript(CHILD_ID);
      expect(store.getState().transcripts[CHILD_ID].messages).toHaveLength(2);

      onFrames[0](childAccepted({ requestId: resumeSubagent.mock.calls[0][2] as string }));

      const users = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        id: 'server-user-1',
        turnId: 'server-turn-1',
        origin: 'parent',
        content: { type: 'user', text: 'also check the relay' },
      });
    });

    /**
     * The pathological edge of that drop: if the server's `userMessageId`
     * were ever the SAME uuid the client chose as its `requestId`, the row
     * matching the echo and the row proving the server's copy is present
     * would be one and the same — dropping it would delete the only copy of
     * the user's sentence. The drop therefore only fires when they are two
     * different rows.
     */
    it('never drops the local row on the strength of ITSELF', async () => {
      let requestId: string | undefined;
      const { rest } = fakeRest({
        resumeSubagentImpl: async (_childId: string, _message: string, id?: string) => {
          requestId = id;
          return { ok: true, status: 'running', mode: 'resumed' };
        },
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay', { optimistic: true });
      // A uuid collision: the server's id for the user row IS the client's
      // correlation id.
      onFrames[0](childAccepted({ requestId, userMessageId: requestId }));

      const users = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        id: requestId,
        turnId: 'server-turn-1',
        content: { type: 'user', text: 'also check the relay' },
      });
    });

    /**
     * Fix round 4, ruling 3. `requestId` is a value the CLIENT chose, and the
     * `accepted` echoing it reaches every sink subscribed to the child — not
     * just the sink that sent the resume. So a peer (or a replayed frame) can
     * name any id it likes. `isLocalResumeRow` therefore requires
     * `m.turnId === m.id` as well: the gateway mints `userMessageId`
     * independently of the turn id, so a PERSISTED row can never satisfy it,
     * while both client producers deliberately do.
     *
     * Without that clause a crafted `requestId` naming a server row already in
     * the transcript makes `dropPreemptedLocalRow` DELETE it — the user's own
     * sentence, gone from every watcher's transcript.
     */
    it('never drops a SERVER row named by a crafted requestId', async () => {
      const victim = message({
        id: 'server-user-1',
        conversationId: CHILD_ID,
        turnId: 'server-turn-0',
        ordinal: 4,
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'the sentence a peer wants gone' },
      });
      const newTurnRow = message({
        id: 'server-user-9',
        conversationId: CHILD_ID,
        turnId: 'server-turn-9',
        ordinal: 5,
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'the turn actually being accepted' },
      });
      const { rest } = fakeRest({
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [victim, newTurnRow] : [],
          nextCursor: null,
          throughSeq: 9,
        }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);

      // Both ids belong to the server. `requestId` names the victim; the
      // `server !== local` guard is satisfied by the other row, so nothing but
      // the `turnId === id` clause stands between the victim and deletion.
      onFrames[0](
        childAccepted({
          id: 'server-turn-9',
          userMessageId: 'server-user-9',
          requestId: 'server-user-1',
        }),
      );

      const users = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(2);
      expect(users.map((m) => m.id)).toEqual(['server-user-1', 'server-user-9']);
    });

    /**
     * The other half of the same hardening: with no second row to satisfy the
     * `server !== local` guard the drop cannot fire, but the `requestId`
     * branch of `reconcileAccepted` uses the same predicate — so a crafted
     * `requestId` would instead RELABEL the server row onto the new turn's
     * ids, silently re-attributing one turn's message to another.
     */
    it('never relabels a SERVER row named by a crafted requestId', async () => {
      const victim = message({
        id: 'server-user-1',
        conversationId: CHILD_ID,
        turnId: 'server-turn-0',
        ordinal: 4,
        role: 'user',
        origin: 'parent',
        content: { type: 'user', text: 'the sentence a peer wants moved' },
      });
      const { rest } = fakeRest({
        getMessagesImpl: async (conversationId: string) => ({
          items: conversationId === CHILD_ID ? [victim] : [],
          nextCursor: null,
          throughSeq: 9,
        }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await store.getState().loadSubagentTranscript(CHILD_ID);

      onFrames[0](
        childAccepted({
          id: 'server-turn-9',
          userMessageId: 'server-user-9',
          requestId: 'server-user-1',
        }),
      );

      const users = store
        .getState()
        .transcripts[CHILD_ID].messages.filter((m) => m.role === 'user');
      // The victim keeps BOTH its ids; the unpaired `parent` frame materialises
      // its own row, which is the documented cost of never guessing.
      expect(users.find((m) => m.id === 'server-user-1')).toMatchObject({
        turnId: 'server-turn-0',
        content: { type: 'user', text: 'the sentence a peer wants moved' },
      });
    });

    it('reconciles even when the accepted frame beats the REST response', async () => {
      // The gateway starts the turn INSIDE `sendToChild`, before the route
      // answers, so this ordering is the realistic one — the local id has to
      // be recorded before the `await`, not after it.
      let release: (() => void) | null = null;
      let requestId: string | undefined;
      const { rest } = fakeRest({
        resumeSubagentImpl: (_childId: string, _message: string, id?: string) => {
          requestId = id;
          return new Promise((resolve) => {
            release = () => resolve({ ok: true, status: 'running', mode: 'resumed' });
          });
        },
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      // `sendToSubagent` runs synchronously up to its `await`, so the resume
      // promise's executor — and therefore `release` — is already set here.
      // The correlation id travels IN the request, so the gateway can echo it
      // on a frame that beats the response.
      const sent = store.getState().sendToSubagent(CHILD_ID, 'early', { optimistic: true });
      expect(release).not.toBeNull();
      onFrames[0](childAccepted({ requestId }));
      (release as unknown as () => void)();
      await sent;

      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ id: 'server-user-1', status: 'completed' });
    });

    it("reconciles a queued STEER's accepted, which only lands when the current turn ends", async () => {
      const { rest, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'queued' }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'and the gateway too', { optimistic: true });

      // Nothing has come back yet, but the send DID succeed: the row must not
      // sit at `accepted` for the life of the store.
      const queued = store.getState().transcripts[CHILD_ID].messages;
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe('completed');

      // Minutes later, the child finishes its turn and starts the steer. The
      // echo is what makes that gap survivable however many turns intervene.
      onFrames[0](childAccepted({ requestId: resumeSubagent.mock.calls[0][2] as string }));

      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'server-user-1',
        content: { type: 'user', text: 'and the gateway too' },
      });
    });

    // An answer resolves inside the child's running turn, so no `accepted`
    // ever carries its correlation id. Nothing is withdrawn at send time any
    // more — an id that is never echoed simply never matches.
    it('does not let a later turn steal the row of an ANSWER, which gets no accepted', async () => {
      const { rest } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'queued' }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'the staging one', { optimistic: true });
      expect(store.getState().transcripts[CHILD_ID].messages[0].status).toBe('completed');

      // An unrelated later turn on the child (the orchestrator's own
      // `send_message`, say). It must materialise its OWN row rather than
      // relabelling the answer.
      onFrames[0](childAccepted());

      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ content: { type: 'user', text: 'the staging one' } });
      expect(messages[1]).toMatchObject({ id: 'server-user-1', turnId: 'server-turn-1' });
    });

    /**
     * Fix round 3, C-1. The positional FIFO paired a follow-up with whatever
     * `parent`-origin `accepted` arrived next, so ONE missed `accepted` — a
     * collapsed row is enough, since the gateway replays nothing on the next
     * `subscribe` — mis-paired every follow-up after it, permanently. The
     * pairing is now keyed on the `requestId` the client chose and the
     * gateway echoes.
     */
    it('reconciles a follow-up to ITS OWN row after an earlier accepted was missed', async () => {
      const { rest, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'queued' }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'first follow-up', { optimistic: true });
      await store.getState().sendToSubagent(CHILD_ID, 'second follow-up', { optimistic: true });
      const secondRequestId = resumeSubagent.mock.calls[1][2] as string;

      // Turn 1's `accepted` never arrives (the row was collapsed while the
      // steer sat on the child's queue). Turn 2's does.
      onFrames[0](
        childAccepted({
          id: 'server-turn-2',
          userMessageId: 'server-user-2',
          requestId: secondRequestId,
        }),
      );

      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(2);
      // The STALE first row keeps its client uuid and is not adopted...
      expect(messages[0]).toMatchObject({ content: { type: 'user', text: 'first follow-up' } });
      expect(messages[0].id).not.toBe('server-user-2');
      // ...and the second reconciles to itself, in place, still in order.
      expect(messages[1]).toMatchObject({
        id: 'server-user-2',
        turnId: 'server-turn-2',
        content: { type: 'user', text: 'second follow-up' },
      });
    });

    // `agent-tool.ts`'s `send_message` starts a child turn with
    // `origin: 'parent'` exactly like a user resume does, and there is no
    // client row for it. Under the FIFO it shifted a user's id off the head
    // and adopted the user's row.
    it("does not let the orchestrator's own send_message adopt a user's row", async () => {
      const { rest, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'queued' }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'the user typed this', { optimistic: true });
      const userRequestId = resumeSubagent.mock.calls[0][2] as string;

      // The orchestrator's turn: `origin: 'parent'`, no correlation id.
      onFrames[0](childAccepted({ id: 'server-turn-9', userMessageId: 'server-user-9' }));

      let messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ content: { type: 'user', text: 'the user typed this' } });
      expect(messages[0].id).not.toBe('server-user-9');

      // The user's own `accepted`, whenever it lands, still finds its row.
      onFrames[0](
        childAccepted({
          id: 'server-turn-10',
          userMessageId: 'server-user-10',
          requestId: userRequestId,
        }),
      );
      messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: 'server-user-10',
        turnId: 'server-turn-10',
        content: { type: 'user', text: 'the user typed this' },
      });
    });

    /**
     * DEGRADED path: a gateway too old to echo `requestId`. There is no way
     * to tell its `accepted` apart from the orchestrator's own — both are
     * `origin: 'parent'` with no id — so the client must NOT guess. It
     * materialises a row, which is round 1's honest duplicate: the same
     * sentence twice, both in order, self-healing on the next REST replay of
     * the server row. That is the floor, and it is strictly better than
     * adopting the wrong row.
     */
    it('materialises rather than guessing when the gateway echoes no requestId', async () => {
      const { rest } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'queued' }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay', { optimistic: true });
      onFrames[0](childAccepted());

      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        content: { type: 'user', text: 'also check the relay' },
      });
      expect(messages[1]).toMatchObject({ id: 'server-user-1', turnId: 'server-turn-1' });
    });

    it('sends the optimistic row id as the requestId, so the echo names the row', async () => {
      const { rest, resumeSubagent } = fakeRest({
        resumeSubagentImpl: async () => ({ ok: true, status: 'running', mode: 'queued' }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      const sent = store
        .getState()
        .sendToSubagent(CHILD_ID, 'and the gateway too', { optimistic: true });
      const localId = store.getState().transcripts[CHILD_ID].messages[0].id;
      await sent;

      expect(resumeSubagent).toHaveBeenCalledWith(CHILD_ID, 'and the gateway too', localId);
    });

    // Trigger 4: the REST call fails on a request the gateway already acted
    // on (a client timeout, a dropped response). The row is marked `failed`,
    // and the `accepted` that eventually arrives repairs it instead of
    // producing a second copy.
    it('repairs a row marked failed when its accepted arrives anyway', async () => {
      let capturedRequestId: string | undefined;
      const { rest } = fakeRest({
        resumeSubagentImpl: async (_childId: string, _message: string, requestId?: string) => {
          capturedRequestId = requestId;
          throw new MobileApiError(504, 'internal');
        },
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await expect(
        store
          .getState()
          .sendToSubagent(CHILD_ID, 'it went through after all', { optimistic: true }),
      ).rejects.toBeInstanceOf(MobileApiError);
      expect(store.getState().transcripts[CHILD_ID].messages[0].status).toBe('failed');

      onFrames[0](childAccepted({ requestId: capturedRequestId }));

      const messages = store.getState().transcripts[CHILD_ID].messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'server-user-1',
        turnId: 'server-turn-1',
        status: 'completed',
      });
    });

    it('marks the optimistic child row failed and rethrows when the resume is refused', async () => {
      const { rest } = fakeRest({
        resumeSubagentImpl: async () => {
          throw new MobileApiError(409, 'validation_failed');
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await expect(
        store.getState().sendToSubagent(CHILD_ID, 'nope', { optimistic: true }),
      ).rejects.toBeInstanceOf(MobileApiError);

      expect(store.getState().transcripts[CHILD_ID].messages[0]).toMatchObject({
        status: 'failed',
        content: { type: 'user', text: 'nope' },
      });
    });
  });

  /**
   * The tasks panel's model (D3, design §8.4). REST is the source of truth
   * here, not the transcript fold: the fold can only see children whose
   * events sit in a message this client has loaded, it never learns that a
   * BACKGROUND child finished after its spawning turn ended, and it is blind
   * across a gateway restart. The panel re-reads instead.
   */
  describe('sub-agent list (D3)', () => {
    const CHILD_ID = 'child-1';
    const ENDED_AT = '2026-09-04T10:01:00.000Z';

    function listEntry(overrides: Partial<SubagentListEntry> = {}): SubagentListEntry {
      return {
        id: CHILD_ID,
        type: 'Explore',
        description: 'Map gateway internals',
        status: 'running',
        background: false,
        depth: 1,
        startedAt: '2026-09-04T10:00:00.000Z',
        toolCallCount: 3,
        oneShot: true,
        ...overrides,
      };
    }

    it("records the conversation's children in the gateway's order, with their facts", async () => {
      const { rest, listSubagents } = fakeRest({
        listSubagentsImpl: async () => ({
          subagents: [listEntry(), listEntry({ id: 'child-2', type: 'Plan', status: 'done' })],
        }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await store.getState().refreshSubagents(CONVERSATION_ID);

      expect(listSubagents).toHaveBeenCalledWith(CONVERSATION_ID);
      expect(store.getState().subagentIds[CONVERSATION_ID]).toEqual([CHILD_ID, 'child-2']);
      expect(store.getState().subagents[CHILD_ID].facts).toMatchObject({ status: 'running' });
      expect(store.getState().subagents['child-2'].facts).toMatchObject({ status: 'done' });
    });

    /**
     * The facts share a key with the row's expansion and its composer's
     * in-flight flag. A refresh that ASSIGNED over the entry would snap an
     * open row shut, or disarm a composer mid-send, every time any child in
     * the conversation changed status.
     */
    it('merges into the row it already has, rather than replacing it', async () => {
      const { rest } = fakeRest({ listSubagentsImpl: async () => ({ subagents: [listEntry()] }) });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      store.getState().patchSubagent(CHILD_ID, { expanded: true });

      await store.getState().refreshSubagents(CONVERSATION_ID);

      expect(store.getState().subagents[CHILD_ID].expanded).toBe(true);
      expect(store.getState().subagents[CHILD_ID].facts).toBeDefined();
    });

    /**
     * Round-1 fix I3a, the store half. Every trigger allocates a fresh entry
     * and a fresh `facts` object for every child in the list, whether or not
     * the gateway said anything new — and a `done` on the open conversation
     * is a trigger, so an ordinary chat with one finished child paid this on
     * every assistant turn. Both of `SubagentBlock`'s subscriptions compare
     * by reference, so that re-rendered every mounted row and its whole
     * nested transcript.
     *
     * The component-side narrowing is pinned in `SubagentBlock.test.tsx`;
     * this pins the cheaper half — an identical read is not written at all,
     * so nothing downstream can see it. Reference equality is the assertion
     * BECAUSE reference equality is what every subscriber uses.
     */
    it('writes nothing at all when a re-read returns identical rows', async () => {
      const { rest } = fakeRest({
        listSubagentsImpl: async () => ({
          subagents: [
            listEntry({ usage: { inputTokens: 10, outputTokens: 20 } }),
            listEntry({ id: 'child-2', type: 'Plan', status: 'done' }),
          ],
        }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(store.getState().subagents[CHILD_ID]).toBeDefined());
      const before = store.getState();

      await store.getState().refreshSubagents(CONVERSATION_ID);

      const after = store.getState();
      // `usage` is a nested object the JSON parse re-allocates every read, so
      // a shallow compare would call this changed. It is compared field-wise.
      expect(after.subagents[CHILD_ID]).toBe(before.subagents[CHILD_ID]);
      expect(after.subagents['child-2']).toBe(before.subagents['child-2']);
      expect(after.subagentIds[CONVERSATION_ID]).toBe(before.subagentIds[CONVERSATION_ID]);
    });

    /** The skip is field-equality, not "already have an entry": a real change
     * still lands, and only on the child that changed. */
    it('writes only the child whose facts actually changed', async () => {
      let status = 'running';
      const { rest } = fakeRest({
        listSubagentsImpl: async () => ({
          subagents: [
            listEntry({ status } as Partial<SubagentListEntry>),
            listEntry({ id: 'child-2' }),
          ],
        }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(store.getState().subagents[CHILD_ID]).toBeDefined());
      const before = store.getState();

      status = 'done';
      await store.getState().refreshSubagents(CONVERSATION_ID);

      const after = store.getState();
      expect(after.subagents[CHILD_ID]).not.toBe(before.subagents[CHILD_ID]);
      expect(after.subagents[CHILD_ID].facts).toMatchObject({ status: 'done' });
      expect(after.subagents['child-2']).toBe(before.subagents['child-2']);
    });

    /**
     * The same race `flushChildSubscriptions` guards: the read for the
     * conversation being left can land after the switch, and writing then
     * puts a dead conversation's children into a record the switch just
     * emptied — where nothing but the NEXT switch would ever remove them.
     */
    it('drops a response that lands after the conversation changed', async () => {
      // EVERY read hangs until this test releases it by hand, `conv-2`'s
      // included. Fix I3c: the previous fixture answered `conv-2` instantly,
      // which moved `appliedSubagentReadSeq` past the stale read before it
      // ever landed — so the THIRD guard (`readSeq <= appliedSubagentReadSeq`)
      // dropped it and the two guards this test is named for were never
      // reached. It passed with the conversation-switch guard removed, with
      // `clearChildSubscriptions`'s seq bump removed, and with BOTH removed.
      // Leaving `conv-2`'s read in flight is the realistic ordering — a
      // switch is exactly when the old conversation's read is still out — and
      // it is what makes the stale response genuinely arrive first.
      const pending: Array<{ conversationId: string; release: () => void }> = [];
      const { rest } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-01' })],
          nextCursor: null,
        },
        listSubagentsImpl: async (conversationId: string) => {
          await new Promise<void>((resolve) => {
            pending.push({ conversationId, release: resolve });
          });
          return { subagents: conversationId === CONVERSATION_ID ? [listEntry()] : [] };
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      // `openConversation`'s own read, left hanging with the rest.
      await vi.waitFor(() => expect(pending).toHaveLength(1));

      const refreshing = store.getState().refreshSubagents(CONVERSATION_ID);
      await vi.waitFor(() => expect(pending).toHaveLength(2));

      await openAndConnect(store, sockets, 'conv-2');
      await vi.waitFor(() => expect(pending).toHaveLength(3));
      expect(pending[2].conversationId).toBe('conv-2');

      // The stale read answers while `conv-2`'s is still out.
      pending[1].release();
      await refreshing;

      expect(store.getState().subagentIds[CONVERSATION_ID]).toBeUndefined();
      expect(store.getState().subagents[CHILD_ID]).toBeUndefined();
    });

    /**
     * Every trigger fires in bursts — three children starting inside one turn
     * is three reads — and nothing makes REST answer them in order. A read
     * issued BEFORE a child finished can resolve after one issued after it,
     * and last-write-wins would then park the panel on the older snapshot
     * with nothing left to correct it.
     */
    it('applies only the newest read when two overlap out of order', async () => {
      const releases: Array<() => void> = [];
      let call = 0;
      const { rest } = fakeRest({
        listSubagentsImpl: async () => {
          const index = call++;
          await new Promise<void>((resolve) => {
            releases[index] = resolve;
          });
          // `index` is the CALL counter, and call 0 is `openConversation`'s
          // own read — released and settled below, before the interesting
          // part. The STALE read is call 1 and the FRESH read is call 2, so
          // it is call 1 that has to differ. Fix I3b: this fixture said
          // `index === 0`, which gave both of the overlapping reads `'done'`
          // and made the final assertion true whichever of them won.
          return { subagents: [listEntry({ status: index === 1 ? 'running' : 'done' })] };
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      // `openConversation`'s own read is the first; release it and settle.
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      releases[0]();
      await vi.advanceTimersByTimeAsync(0);

      const stale = store.getState().refreshSubagents(CONVERSATION_ID);
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      const fresh = store.getState().refreshSubagents(CONVERSATION_ID);
      await vi.waitFor(() => expect(releases).toHaveLength(3));

      // The NEWER read answers first, then the stale one.
      releases[2]();
      await fresh;
      releases[1]();
      await stale;

      expect(store.getState().subagents[CHILD_ID].facts).toMatchObject({ status: 'done' });
    });

    it('reads the list when a conversation is opened, and clears it on the way out', async () => {
      const { rest, listSubagents } = fakeRest({
        conversationPage: {
          items: [summary(), summary({ id: 'conv-2', agentId: 'agent-01' })],
          nextCursor: null,
        },
        listSubagentsImpl: async (conversationId: string) => ({
          subagents: conversationId === CONVERSATION_ID ? [listEntry()] : [],
        }),
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await vi.waitFor(() =>
        expect(store.getState().subagentIds[CONVERSATION_ID]).toEqual([CHILD_ID]),
      );
      expect(listSubagents).toHaveBeenCalledWith(CONVERSATION_ID);

      await openAndConnect(store, sockets, 'conv-2');

      expect(store.getState().subagentIds[CONVERSATION_ID]).toBeUndefined();
    });

    /**
     * A failed read must not take the conversation down — it rides beside the
     * subscription, which swallows everything for the same reason — but a
     * dead credential still routes like every other REST call here.
     */
    it('swallows a failed read, and routes a 401', async () => {
      const { rest } = fakeRest({
        listSubagentsImpl: async () => {
          throw new MobileApiError(401, 'unauthorized');
        },
      });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      await expect(store.getState().refreshSubagents(CONVERSATION_ID)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(store.getState().connection).toBe('unauthorized'));
    });

    /**
     * Without this the panel sits on whatever it read when the conversation
     * opened: `subagent_progress` is transient and never persisted, so a
     * child that started, or finished, mid-turn would not appear (or would
     * not stop spinning) until the user navigated away and back.
     */
    it('re-reads the list when a child starts or finishes on the open conversation', async () => {
      const { rest, listSubagents } = fakeRest({
        listSubagentsImpl: async () => ({ subagents: [listEntry()] }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

      onFrames[0]({
        type: 'event',
        id: 'turn-1',
        conversationId: CONVERSATION_ID,
        seq: 5,
        event: { type: 'subagent_started', subagentId: 'child-2' },
      } as MobileWsServerFrame);
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));

      onFrames[0]({
        type: 'event',
        id: 'turn-1',
        conversationId: CONVERSATION_ID,
        seq: 6,
        event: { type: 'subagent_finished', subagentId: 'child-2', status: 'done' },
      } as MobileWsServerFrame);
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(3));

      // A text delta is not a list change and must not cost a round trip.
      onFrames[0]({
        type: 'event',
        id: 'turn-1',
        conversationId: CONVERSATION_ID,
        seq: 7,
        event: { type: 'text_delta', text: 'hello' },
      } as MobileWsServerFrame);
      await vi.advanceTimersByTimeAsync(0);
      expect(listSubagents).toHaveBeenCalledTimes(3);
    });

    /**
     * The trigger a BACKGROUND child needs, and the reason the panel is
     * called what it is. A background child outlives the turn that spawned
     * it: its finish is delivered to the parent as a NOTIFICATION TURN
     * (design §7.3/§8.5), not as a `subagent_finished` inside the message
     * that started it, so the two per-child triggers above never fire for it
     * and the row would read `running` until the user navigated away and
     * back. One read per parent turn covers it, and is cheaper than the
     * per-child triggers it backstops.
     */
    it('re-reads the list when a notification turn starts, and again when it finishes', async () => {
      const { rest, listSubagents } = fakeRest({
        listSubagentsImpl: async () => ({ subagents: [listEntry({ background: true })] }),
      });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

      // A notification turn: the gateway started it, and the background
      // child's finish is the only thing it is about.
      onFrames[0]({
        type: 'accepted',
        id: 'turn-9',
        conversationId: CONVERSATION_ID,
        userMessageId: 'user-9',
        assistantMessageId: 'asst-9',
        seq: 9,
        revision: 3,
        origin: 'notification',
      } as MobileWsServerFrame);

      // Round-1 ruling 5. The child's terminal row is ALREADY persisted by
      // the time the notification turn is accepted (`finalizeTerminal`
      // persists before it enqueues), so waiting for `done` left the row
      // reading `running` for the whole length of the turn its own finish
      // triggered — which is exactly the case the panel exists for, and can
      // be many seconds of model output.
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));

      onFrames[0]({
        type: 'done',
        id: 'turn-9',
        conversationId: CONVERSATION_ID,
        turnId: 'turn-9',
        seq: 10,
      } as MobileWsServerFrame);

      // And `done` still fires: it is the trigger that backstops every other
      // one going missing, and a child spawned DURING the notification turn
      // is only visible after it.
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(3));
    });

    /**
     * Only `notification`. An ordinary user turn's `accepted` is the common
     * case by a wide margin and says nothing about any child — the `done` at
     * the end of it already re-reads. Triggering on every `accepted` would
     * double the per-turn cost for nothing.
     */
    it("does not re-read on an ordinary turn's accepted", async () => {
      const { rest, listSubagents } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

      onFrames[0]({
        type: 'accepted',
        id: 'turn-9',
        conversationId: CONVERSATION_ID,
        userMessageId: 'user-9',
        assistantMessageId: 'asst-9',
        seq: 9,
        revision: 3,
        origin: 'user',
      } as MobileWsServerFrame);
      await vi.advanceTimersByTimeAsync(0);

      expect(listSubagents).toHaveBeenCalledTimes(1);
    });

    /** The gateway replays nothing on a re-`subscribe`, so everything that
     * happened to a child while the socket was down is gone from this client
     * unless it re-reads — same reason `refreshChildTranscripts` exists. */
    it('re-reads the list after a reconnect', async () => {
      const { rest, listSubagents } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

      onCloses[0]('error');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(sockets.length).toBe(2));
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));

      await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));
    });

    describe('stopSubagent', () => {
      it('cancels through the REST route and takes the status it answers with', async () => {
        let releaseReread: (() => void) | null = null;
        const { rest, stopSubagent, listSubagents } = fakeRest({
          listSubagentsImpl: async () => {
            // The FIRST read is `openConversation`'s and answers at once; the
            // one the stop triggers is held open, so the assertion below can
            // only pass on the optimistic write.
            if (listSubagents.mock.calls.length > 1) {
              await new Promise<void>((resolve) => {
                releaseReread = resolve;
              });
              return { subagents: [listEntry({ status: 'cancelled', endedAt: ENDED_AT })] };
            }
            return { subagents: [listEntry()] };
          },
          stopSubagentImpl: async () => ({ ok: true, status: 'cancelled' as const }),
        });
        const { factory, sockets } = scriptedSocketFactory();
        const store = createWebAppStore({ rest, socketFactory: factory });
        await openAndConnect(store, sockets, CONVERSATION_ID);
        await vi.waitFor(() => expect(store.getState().subagents[CHILD_ID]?.facts).toBeDefined());
        const callsBefore = listSubagents.mock.calls.length;

        const stopping = store.getState().stopSubagent(CHILD_ID);

        // Applied at once rather than waiting for the re-read: the response
        // is authoritative and the button has to stop offering a stop.
        await vi.waitFor(() =>
          expect(store.getState().subagents[CHILD_ID].facts).toMatchObject({
            status: 'cancelled',
          }),
        );
        expect(stopSubagent).toHaveBeenCalledWith(CHILD_ID);
        expect(store.getState().subagents[CHILD_ID].facts).not.toHaveProperty('endedAt');

        await vi.waitFor(() => expect(releaseReread).not.toBeNull());
        (releaseReread as unknown as () => void)();
        await stopping;

        // And the re-read still lands, for everything the stop response does
        // not carry.
        expect(listSubagents.mock.calls.length).toBeGreaterThan(callsBefore);
        expect(store.getState().subagents[CHILD_ID].facts).toMatchObject({
          status: 'cancelled',
          endedAt: ENDED_AT,
        });
      });

      /**
       * A 409 is the gateway saying the child finished on its own first. The
       * user's intent is satisfied, so it is not an error to report — but it
       * is proof this client's picture is stale, which is exactly when the
       * re-read matters most.
       */
      it('re-reads after a 409 and does not treat it as a failure', async () => {
        const { rest, listSubagents } = fakeRest({
          listSubagentsImpl: async () => ({ subagents: [listEntry({ status: 'done' })] }),
          stopSubagentImpl: async () => {
            throw new MobileApiError(409, 'validation_failed', 'Sub-agent child-1 is already done');
          },
        });
        const { factory, sockets } = scriptedSocketFactory();
        const store = createWebAppStore({ rest, socketFactory: factory });
        await openAndConnect(store, sockets, CONVERSATION_ID);
        await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

        await expect(store.getState().stopSubagent(CHILD_ID)).resolves.toBeUndefined();

        await vi.waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));
        expect(store.getState().subagents[CHILD_ID].facts).toMatchObject({ status: 'done' });
      });

      it('rethrows anything that is not a raced finish, and routes a 401', async () => {
        const { rest } = fakeRest({
          stopSubagentImpl: async () => {
            throw new MobileApiError(401, 'unauthorized');
          },
        });
        const { factory, sockets } = scriptedSocketFactory();
        const store = createWebAppStore({ rest, socketFactory: factory });
        await openAndConnect(store, sockets, CONVERSATION_ID);

        await expect(store.getState().stopSubagent(CHILD_ID)).rejects.toBeInstanceOf(
          MobileApiError,
        );
        expect(store.getState().connection).toBe('unauthorized');
      });
    });
  });

  /**
   * A BACKGROUND child is the only kind that outlives the turn that launched
   * it: `run.ts:268` (`if (h.background) continue;`) leaves it running through
   * that turn's finalize, and `emitToParent` (`coordinator.ts:1560`) pushes its
   * heartbeat into whatever turn is live NOW, because `this.live` is keyed
   * `(agentId, conversationId)`. So a turn-1 child heartbeats onto turn 2's
   * stream, where it has no `subagent_started` — and `groupSubagentEvents`
   * (`ui/blocks/subagents.ts:267-291`) drafts a group for any `subagentIdOf`
   * hit and clears `orphan` only on a start. What the user would see is a
   * second, unlabelled card (header `{group.type || 'agent'}`, blank
   * description, no `startedAt`) carrying the question and a live
   * `subagent-reply` composer (`SubagentBlock.tsx:262-274`), for a child whose
   * real card is already in turn 1's confirmed message —
   * `ChatView.tsx:980-990` renders the live stream through
   * `ContentBlocks.tsx:271` raw and never runs it through D2's
   * `mergeSubagentEventLists`, which folds CONFIRMED messages only.
   *
   * The rule, ported from MC's `1d2e641c`: a transient (seq-less) frame
   * updates the stream it BELONGS to — the one its child is anchored in — or
   * it is dropped.
   */
  describe('a transient sub-agent frame on the parent stream (E3)', () => {
    const BG_CHILD = 'sub_a';
    const QUESTION = 'which file should I read, src/alpha.ts or src/beta.ts?';

    function accepted(turnId: string, seq: number): MobileWsServerFrame {
      return {
        type: 'accepted',
        id: turnId,
        conversationId: CONVERSATION_ID,
        userMessageId: `user-${turnId}`,
        assistantMessageId: `asst-${turnId}`,
        revision: seq,
        seq,
      };
    }

    function startedChild(turnId: string, seq: number): MobileWsServerFrame {
      return {
        type: 'event',
        id: turnId,
        conversationId: CONVERSATION_ID,
        seq,
        event: {
          type: 'subagent_started',
          subagentId: BG_CHILD,
          subagentType: 'Explore',
          description: 'map the code',
          background: true,
          depth: 1,
          startedAt: '2026-09-04T00:00:00.000Z',
        },
      } as unknown as MobileWsServerFrame;
    }

    /** The real wire shape: no `seq`, because the gateway never logs a
     * transient event (`chat-ws.ts:555`, `resumable-chat-hub.ts:382`). */
    function heartbeat(turnId: string, over: { elapsedMs?: number } = {}): MobileWsServerFrame {
      return {
        type: 'event',
        id: turnId,
        conversationId: CONVERSATION_ID,
        event: {
          type: 'subagent_progress',
          subagentId: BG_CHILD,
          status: 'waiting_input',
          question: QUESTION,
          toolCallCount: 0,
          elapsedMs: over.elapsedMs ?? 30_000,
        },
      } as unknown as MobileWsServerFrame;
    }

    async function connected(): Promise<{
      store: ReturnType<typeof createWebAppStore>;
      onFrame: FrameHandler;
    }> {
      const { rest } = fakeRest({});
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);
      return { store, onFrame: onFrames[0] };
    }

    /** The live stream the card fold walks — `ChatView.tsx:980-990` passes
     * exactly this array to `<ContentBlocks streaming />`. */
    function liveEvents(store: ReturnType<typeof createWebAppStore>): MobileAgentEvent[] {
      const streaming = store.getState().transcripts[CONVERSATION_ID]?.streaming;
      return streaming && streaming.type === 'assistant' ? streaming.events : [];
    }

    /** Turn 1 launches the background child and ends; turn 2 opens its own
     * stream; the still-running child heartbeats into it. */
    async function heartbeatIntoTheNextTurn(): Promise<{
      store: ReturnType<typeof createWebAppStore>;
    }> {
      const { store, onFrame } = await connected();
      onFrame(accepted('turn-1', 1));
      onFrame(startedChild('turn-1', 2));
      onFrame({ type: 'done', id: 'turn-1', conversationId: CONVERSATION_ID, seq: 3 });
      // `assemble.ts`'s `case 'done'` returns `streaming: null`: web empties
      // the live stream on a turn's end exactly as MC's `refreshTerminal`
      // does. Asserted, because the whole defect hangs off it.
      expect(store.getState().transcripts[CONVERSATION_ID]?.streaming).toBeNull();
      onFrame(accepted('turn-2', 4));
      onFrame({
        type: 'event',
        id: 'turn-2',
        conversationId: CONVERSATION_ID,
        seq: 5,
        event: { type: 'text_delta', text: 'on the next turn now' },
      });

      onFrame(heartbeat('turn-2'));
      return { store };
    }

    it("drops a background child's heartbeat into a turn that never started it", async () => {
      const { store } = await heartbeatIntoTheNextTurn();

      expect(liveEvents(store).map((event) => event.type)).toEqual(['text_delta']);
    });

    it('mints no orphan card from it — a lone progress event is enough for one', async () => {
      const { store } = await heartbeatIntoTheNextTurn();

      expect(groupSubagentEvents(liveEvents(store), true)).toEqual([]);
    });

    /**
     * The case the gate must NOT break, and the one §32.6 is about: a child
     * parked on `ask_orchestrator` INSIDE the live turn is anchored in that
     * same stream, so its question and reply box still reach the row.
     */
    it('delivers a heartbeat for a child anchored in THIS stream — the parked row keeps its question', async () => {
      const { store, onFrame } = await connected();
      onFrame(accepted('turn-1', 1));
      onFrame(startedChild('turn-1', 2));

      onFrame(heartbeat('turn-1'));

      expect(liveEvents(store).map((event) => event.type)).toEqual([
        'subagent_started',
        'subagent_progress',
      ]);
      const groups = groupSubagentEvents(liveEvents(store), true);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        subagentId: BG_CHILD,
        orphan: false,
        status: 'waiting',
        question: QUESTION,
        type: 'Explore',
        description: 'map the code',
      });
    });

    /**
     * `PROGRESS_THROTTLE_MS` is 1_000 (`packages/swarm/src/child-handle.ts:75`),
     * so a busy child emits one of these a second for the whole turn and the
     * fold is last-write-wins per child: every heartbeat but the newest is dead
     * weight in an array `groupSubagentEvents` re-walks on each one. Replaced
     * in PLACE, so the array holds at most one per child and no `anchorIndex`
     * the fold reads ever moves.
     */
    it('coalesces a child heartbeat rather than appending one per second', async () => {
      const { store, onFrame } = await connected();
      onFrame(accepted('turn-1', 1));
      onFrame(startedChild('turn-1', 2));

      onFrame(heartbeat('turn-1', { elapsedMs: 30_000 }));
      onFrame(heartbeat('turn-1', { elapsedMs: 31_000 }));

      expect(liveEvents(store).map((event) => event.type)).toEqual([
        'subagent_started',
        'subagent_progress',
      ]);
      expect((liveEvents(store)[1] as { elapsedMs?: number }).elapsedMs).toBe(31_000);
    });
  });
});
