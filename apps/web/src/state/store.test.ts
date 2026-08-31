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
  const rest = {
    listConversations,
    getMessages,
    identity,
    createConversation,
    listAgents,
  } as unknown as MobileRestClient;
  return { rest, listConversations, getMessages, identity, createConversation, listAgents };
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

      await store.getState().resendFromMessage(CONVERSATION_ID, 'u1');

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

      await store.getState().resendFromMessage(CONVERSATION_ID, 'u1', 'Edited text');

      const messages = store.getState().transcripts[CONVERSATION_ID]?.messages ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ content: { type: 'user', text: 'Edited text' } });
      expect(sockets[0].sent[0]).toMatchObject({ type: 'message', text: 'Edited text' });
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

      await store.getState().resendFromMessage(CONVERSATION_ID, 'a1');
      await store.getState().resendFromMessage(CONVERSATION_ID, 'does-not-exist');

      expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toEqual([assistantOnly]);
      expect(sockets[0].sent).toHaveLength(0);
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
  });

  describe('frame handling', () => {
    it('reconciles the optimistic user message id and assembles the streaming assistant reply', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
  });

  describe('cancelTurn (chat-ux Phase 2 Task 2, audit #3)', () => {
    it('sends a cancel frame keyed on the accepted turn id', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();
      await openAndConnect(store, sockets, CONVERSATION_ID);

      store.getState().cancelTurn(CONVERSATION_ID);

      expect(sockets[0].sent).toHaveLength(0);
    });

    it('is a no-op for a conversation id other than the one the live socket is attached to', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
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
      const store = createWebAppStore({ rest, socketFactory: factory });
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
});
