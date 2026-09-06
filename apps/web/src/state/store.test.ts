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
import type { ChatSocket, FrameHandler } from '../api/chat-socket';
import { MobileApiError, type MobileRestClient } from '../api/rest';
import { RECONNECT_BASE_MS, RECONNECT_FACTOR, RECONNECT_MAX_MS, createWebAppStore } from './store';

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

/** A hand-scripted stand-in for `ChatSocket` (Task 9), same spirit as its own
 * `ScriptedWebSocket` test double: `connect()` settles on demand rather than
 * immediately, so tests can drive reconnect timing precisely. */
class ScriptedChatSocket {
  readonly sent: MobileWsClientFrame[] = [];
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

  send(frame: MobileWsClientFrame): void {
    if (this.sendShouldThrow) {
      throw new Error('ChatSocket: cannot send while the socket is not open');
    }
    this.sent.push(frame);
  }

  /** Frames excluding the `subscribe`/`unsubscribe` bookkeeping the store now
   * sends on every connect and conversation switch (task C7) — this is the
   * turn traffic a test means when it asserts on "what was sent". */
  get turnFrames(): MobileWsClientFrame[] {
    return this.sent.filter((f) => f.type !== 'subscribe' && f.type !== 'unsubscribe');
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
  factory: (onFrame: FrameHandler, onClose: (reason: 'error' | 'closed') => void) => ChatSocket;
  sockets: ScriptedChatSocket[];
  onFrames: FrameHandler[];
  onCloses: Array<(reason: 'error' | 'closed') => void>;
}

function scriptedSocketFactory(): ScriptedFactory {
  const sockets: ScriptedChatSocket[] = [];
  const onFrames: FrameHandler[] = [];
  const onCloses: Array<(reason: 'error' | 'closed') => void> = [];
  const factory = vi.fn((onFrame: FrameHandler, onClose: (reason: 'error' | 'closed') => void) => {
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
  resumeSubagent: ReturnType<typeof vi.fn>;
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
  /** Override for `rest.resumeSubagent()` — used by the `sendToSubagent` tests. */
  resumeSubagentImpl?: (childId: string, message: string, requestId?: string) => Promise<unknown>;
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
  const resumeSubagent = vi.fn(
    opts.resumeSubagentImpl ??
      (async () => ({ ok: true, status: 'running', mode: 'queued' as const })),
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
    resumeSubagent,
  } as unknown as MobileRestClient;
  return {
    rest,
    resumeSubagent,
    listConversations,
    getMessages,
    identity,
    createConversation,
    listAgents,
    patchConversation,
    deleteConversation,
    getConversation,
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
      const store = createWebAppStore({ rest, socketFactory: factory });

      expect(store.getState().connection).toBe('idle');
    });

    it("a healthy loadConversations() on an empty account leaves connection 'idle' (not reinterpreted as an outage)", async () => {
      const { rest } = fakeRest({ conversationPage: { items: [], nextCursor: null } });
      const { factory } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

      await store.getState().loadConversations();

      expect(store.getState().conversations).toEqual(page.items);
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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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

    // Chat UX Phase 4 Task 5 (audit #14 remainder): web attachments. Images
    // ride on the same `message` frame iOS/MC send (`MobileWsClientFrame`
    // `images`), and the optimistic user message carries them too so the
    // transcript shows the thumbnails before the gateway echoes them back.
    it('sends images on the optimistic user message and in the ChatSend frame', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error');
      expect(store.getState().connection).toBe('reconnecting');

      await expect(store.getState().sendMessage(CONVERSATION_ID, 'hello')).rejects.toThrow();
      expect(store.getState().transcripts[CONVERSATION_ID]?.messages ?? []).toHaveLength(0);
    });

    it('marks the optimistic message failed (not stuck "accepted") when socket.send() throws', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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

      onCloses[0]('error');
      expect(store.getState().connection).toBe('reconnecting');

      await expect(store.getState().resendFromMessage(CONVERSATION_ID, 'u1')).rejects.toThrow();
      expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toEqual([target]);
    });

    it("is a no-op while a LATER turn is actively streaming — even when messageId names an earlier, already-failed message (regression: used to truncate the in-flight turn's own optimistic message and fire a second, orphaned send)", async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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

    it('rolls back the optimistic title on a REST failure and rethrows', async () => {
      const original = summary({ title: 'Original title', revision: 1 });
      const { rest } = fakeRest({
        conversationPage: { items: [original], nextCursor: null },
        patchConversationImpl: async () => {
          throw new Error('gateway rejected the rename');
        },
      });
      const { factory } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await expect(
        store.getState().renameConversation(CONVERSATION_ID, 'Attempted rename'),
      ).rejects.toThrow('gateway rejected the rename');
      expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
        'Original title',
      );
    });

    it('is a no-op for an unknown conversation id', async () => {
      const { rest, patchConversation } = fakeRest({
        conversationPage: { items: [], nextCursor: null },
      });
      const { factory } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
        const store = createWebAppStore({ rest, socketFactory: factory });
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
        const { rest, getConversation } = fakeRest({
          conversationPage: { items: [original], nextCursor: null },
          patchConversationImpl: async () => {
            throw new MobileApiError(409, 'revision_conflict');
          },
          getConversationImpl: async () => summary({ revision: 5, title: 'Original title' }),
        });
        const { factory } = scriptedSocketFactory();
        const store = createWebAppStore({ rest, socketFactory: factory });
        await store.getState().loadConversations();

        await expect(
          store.getState().renameConversation(CONVERSATION_ID, 'Renamed after conflict'),
        ).rejects.toBeInstanceOf(MobileApiError);

        expect(getConversation).toHaveBeenCalledTimes(1); // refetched exactly once, not looped
        expect(store.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.title).toBe(
          'Original title',
        );
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await store.getState().deleteConversation('missing-conv');
      expect(deleteConversation).not.toHaveBeenCalled();
    });

    it('closes the live socket and clears connection back to idle when deleting the currently open conversation', async () => {
      const target = summary({ id: CONVERSATION_ID, revision: 1 });
      const { rest } = fakeRest({ conversationPage: { items: [target], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
        const store = createWebAppStore({ rest, socketFactory: factory });
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
        const store = createWebAppStore({ rest, socketFactory: factory });
        await store.getState().loadConversations();

        await expect(store.getState().deleteConversation('conv-1')).rejects.toBeInstanceOf(
          MobileApiError,
        );

        expect(getConversation).toHaveBeenCalledTimes(1); // refetched exactly once, not looped
        expect(store.getState().conversations.map((c) => c.id)).toEqual(['conv-1']);
      });
    });
  });

  describe('cancelTurn (chat-ux Phase 2 Task 2, audit #3)', () => {
    it('sends a cancel frame keyed on the accepted turn id', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().cancelTurn(CONVERSATION_ID);

      expect(sockets[0].turnFrames).toHaveLength(0);
    });

    it('is a no-op for a conversation id other than the one the live socket is attached to', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      onCloses[0]('error');
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
      const store = createWebAppStore({ rest, socketFactory: factory });

      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error');
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
      const store = createWebAppStore({
        rest,
        socketFactory: factory,
        reconnect: { maxAttempts: 2 },
      });

      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error'); // attempt 1 scheduled
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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      await openAndConnect(store, sockets, CONVERSATION_ID);
      // Switching conversations closes the first socket without a global flag.
      await openAndConnect(store, sockets, 'conv-2');
      expect(sockets[0].closed).toBe(true);

      // A late close from the now-detached first socket must not affect
      // the (unrelated, still-live) current connection.
      onCloses[0]('closed');
      expect(store.getState().connection).toBe('connected');
      expect(factory).toHaveBeenCalledTimes(2); // no spurious reconnect attempt

      // A genuine drop of the *current* socket still reconnects normally.
      onCloses[1]('error');
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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });

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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error'); // schedules reconnect attempt 1
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
      const store = createWebAppStore({
        rest,
        socketFactory: factory,
        reconnect: { maxAttempts: 1 },
      });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error'); // attempt 1 scheduled
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
      const store = createWebAppStore({
        rest,
        socketFactory: factory,
        reconnect: { maxAttempts: 1 },
      });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error'); // attempt 1 scheduled
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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().dispose();

      expect(sockets[0].closed).toBe(true);
      expect(store.getState().connection).toBe('offline');
    });

    it('cancels a pending reconnect timer so a dropped connection never comes back on its own', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error'); // schedules a reconnect attempt
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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      onCloses[0]('error');
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
      const store = createWebAppStore({ rest, socketFactory: factory });

      expect(() => store.getState().dispose()).not.toThrow();
      expect(() => store.getState().dispose()).not.toThrow();
      expect(store.getState().connection).toBe('offline');
    });

    it('is reusable: a subsequent openConversation() clears the disposed flag and reconnects normally', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().dispose();
      expect(store.getState().connection).toBe('offline');

      await openAndConnect(store, sockets, CONVERSATION_ID);
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
      expect(store.getState().subagentInfo[CHILD_ID]).toMatchObject({ oneShot: true });
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
      expect(store.getState().subagentInfo[CHILD_ID]).toBeUndefined();
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

      expect(store.getState().subagentUi[CHILD_ID]).toBeUndefined();
      store.getState().patchSubagentUi(CHILD_ID, { expanded: true });
      expect(store.getState().subagentUi[CHILD_ID].expanded).toBe(true);
      store.getState().patchSubagentUi(CHILD_ID, { expanded: false });
      expect(store.getState().subagentUi[CHILD_ID].expanded).toBe(false);
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
      store.getState().patchSubagentUi(CHILD_ID, { expanded: true, draft: 'half a thought' });
      store.getState().patchSubagentUi(`group:${CHILD_ID}`, { expanded: false });

      await openAndConnect(store, sockets, 'conv-2');

      expect(store.getState().subagentUi).toEqual({});
    });

    /**
     * Fix round 4, ruling 4. `transcripts` is initialised once and was never
     * reset: `clearChildSubscriptions` dropped the subscriptions, the replay
     * cache and `subagentUi`, but left every child transcript in place. Every
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

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay');

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

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay');
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

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay');
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

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay');
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
      const sent = store.getState().sendToSubagent(CHILD_ID, 'early');
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

      await store.getState().sendToSubagent(CHILD_ID, 'and the gateway too');

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

      await store.getState().sendToSubagent(CHILD_ID, 'the staging one');
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

      await store.getState().sendToSubagent(CHILD_ID, 'first follow-up');
      await store.getState().sendToSubagent(CHILD_ID, 'second follow-up');
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

      await store.getState().sendToSubagent(CHILD_ID, 'the user typed this');
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

      await store.getState().sendToSubagent(CHILD_ID, 'also check the relay');
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

      const sent = store.getState().sendToSubagent(CHILD_ID, 'and the gateway too');
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
        store.getState().sendToSubagent(CHILD_ID, 'it went through after all'),
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

      await expect(store.getState().sendToSubagent(CHILD_ID, 'nope')).rejects.toBeInstanceOf(
        MobileApiError,
      );

      expect(store.getState().transcripts[CHILD_ID].messages[0]).toMatchObject({
        status: 'failed',
        content: { type: 'user', text: 'nope' },
      });
    });
  });
});
