import type {
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import type { ChatSocket, FrameHandler } from '../api/chat-socket';
import type { MobileRestClient } from '../api/rest';
import { RECONNECT_BASE_MS, createWebAppStore } from './store';

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
  private settle: ((outcome: 'resolve' | 'reject') => void) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settle = (outcome) => (outcome === 'resolve' ? resolve() : reject(new Error('boom')));
    });
  }

  send(frame: MobileWsClientFrame): void {
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
  callCount: () => number;
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
  return { factory, sockets, onFrames, onCloses, callCount: () => factory.mock.calls.length };
}

interface FakeRest {
  rest: MobileRestClient;
  listConversations: ReturnType<typeof vi.fn>;
  getMessages: ReturnType<typeof vi.fn>;
}

function fakeRest(opts: {
  conversationPage?: ConversationPage;
  messagePages?: ConversationMessagePage[];
}): FakeRest {
  const messagePages = opts.messagePages ?? [{ items: [], nextCursor: null, throughSeq: 0 }];
  let getMessagesCall = 0;
  const listConversations = vi.fn(
    async () => opts.conversationPage ?? { items: [summary()], nextCursor: null },
  );
  const getMessages = vi.fn(async (_conversationId: string, _cursor?: string) => {
    const page = messagePages[Math.min(getMessagesCall, messagePages.length - 1)];
    getMessagesCall += 1;
    return page;
  });
  const rest = {
    listConversations,
    getMessages,
  } as unknown as MobileRestClient;
  return { rest, listConversations, getMessages };
}

describe('createWebAppStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      sockets[0].open();
      await opening;

      // Oldest-first, reconstructed from the two backward pages.
      expect(store.getState().transcripts[CONVERSATION_ID]?.messages).toEqual([older, newer]);
      expect(getMessages).toHaveBeenNthCalledWith(1, CONVERSATION_ID, undefined);
      expect(getMessages).toHaveBeenNthCalledWith(2, CONVERSATION_ID, 'cursor-1');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(store.getState().connection).toBe('connected');
    });
  });

  describe('sendMessage', () => {
    it('optimistically appends the user message and sends a ChatSend frame', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      sockets[0].open();
      await opening;

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
  });

  describe('frame handling', () => {
    it('reconciles the optimistic user message id and assembles the streaming assistant reply', async () => {
      const { rest } = fakeRest({ conversationPage: { items: [summary()], nextCursor: null } });
      const { factory, sockets, onFrames } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });
      await store.getState().loadConversations();

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      sockets[0].open();
      await opening;

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
  });

  describe('reconnect', () => {
    it('flips to reconnecting on error close, retries with backoff, and reconciles by message id', async () => {
      const existing = message({ id: 'msg-a', ordinal: 1 });
      const reconciled = message({
        id: 'msg-b',
        ordinal: 2,
        role: 'assistant',
        content: { type: 'assistant', events: [{ type: 'text_delta', text: 'back online' }] },
      });
      const { rest, getMessages } = fakeRest({
        messagePages: [
          { items: [existing], nextCursor: null, throughSeq: 1 }, // initial replay
          { items: [existing, reconciled], nextCursor: null, throughSeq: 2 }, // post-reconnect reconcile
        ],
      });
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      sockets[0].open();
      await opening;
      expect(store.getState().connection).toBe('connected');

      // The live socket drops with an error.
      onCloses[0]('error');
      expect(store.getState().connection).toBe('reconnecting');
      expect(factory).toHaveBeenCalledTimes(1); // no new attempt yet — still waiting out backoff

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2)); // fresh ticket per attempt
      sockets[1].open();
      await vi.waitFor(() => expect(store.getState().connection).toBe('connected'));
      await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));

      const finalMessages = store.getState().transcripts[CONVERSATION_ID]?.messages ?? [];
      const ids = finalMessages.map((m) => m.id);
      expect(ids).toEqual(['msg-a', 'msg-b']); // merged, no duplicates
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps retrying with a fresh socket-factory call on each failed attempt', async () => {
      const { rest } = fakeRest({});
      const { factory, sockets, onCloses } = scriptedSocketFactory();
      const store = createWebAppStore({ rest, socketFactory: factory });

      const opening = store.getState().openConversation(CONVERSATION_ID);
      await vi.waitFor(() => expect(sockets.length).toBe(1));
      sockets[0].open();
      await opening;

      onCloses[0]('error');
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
      sockets[1].failToOpen();

      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS * 2);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3));
      expect(store.getState().connection).toBe('reconnecting');
    });
  });
});
