import '@testing-library/jest-dom/vitest';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2PendingInput,
} from '@dash/mobile-contract-v2';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../../vitest.setup.js';
import { projectionFromBootstrap } from '../../../stores/chat-v2-sync.js';
import { type ChatState, conversationKey, useChatStore } from '../../../stores/chat.js';
import { SessionPanel } from './SessionPanel.js';

Element.prototype.scrollIntoView = vi.fn();

const ref: ConversationRef = { id: 'conv-42', origin: 'gateway' };
const key = conversationKey(ref);
const conversation: McConversationView = {
  id: ref.id,
  agentId: 'agent-1',
  agentName: 'Developer',
  title: 'Canonical session',
  revision: 2,
  status: 'idle',
  activeTurnId: null,
  owningIssueId: 'issue_1',
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: null,
  createdAt: '2026-07-12T00:00:00Z',
  updatedAt: '2026-07-12T00:00:00Z',
  kind: 'user',
  origin: 'gateway',
  offline: false,
  readOnly: false,
};

const originalActions = {
  sendMessage: useChatStore.getState().sendMessage,
  enqueueInput: useChatStore.getState().enqueueInput,
  editFollowUp: useChatStore.getState().editFollowUp,
  removeFollowUp: useChatStore.getState().removeFollowUp,
  resumeFollowUps: useChatStore.getState().resumeFollowUps,
} satisfies Partial<ChatState>;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function followUp(
  inputId: string,
  enqueueOrder: number,
  patch: Partial<MobileV2PendingInput> = {},
): MobileV2PendingInput {
  return {
    inputId,
    kind: 'follow_up',
    text: `Follow up ${enqueueOrder}`,
    state: 'queued',
    revision: 1,
    enqueueOrder,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
    ...patch,
  };
}

function questionMessage(conversationId = ref.id): MobileV2ConversationMessage {
  return {
    id: `assistant-question-${conversationId}`,
    conversationId,
    turnId: 'segment-1',
    runId: 'run-1',
    segmentIndex: 0,
    ordinal: 1,
    role: 'assistant',
    status: 'streaming',
    deliveryKind: 'normal',
    content: {
      type: 'assistant',
      events: [{ type: 'question', id: 'question-1', question: 'Ship?', options: ['Yes', 'No'] }],
    },
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
  };
}

function v2Bootstrap(
  view: McConversationView,
  {
    activeTurnId = 'run-1',
    pendingInputs = [],
    messages = [],
    queuePaused = false,
  }: {
    activeTurnId?: string | null;
    pendingInputs?: MobileV2PendingInput[];
    messages?: MobileV2ConversationMessage[];
    queuePaused?: boolean;
  } = {},
): MobileV2ConversationBootstrap {
  return {
    conversation: {
      ...view,
      status: activeTurnId ? 'running' : 'idle',
      activeTurnId,
      queuePaused,
      queueRevision: 3,
      pendingFollowUpCount: pendingInputs.length,
      v2LastSeq: 0,
    },
    messages,
    nextCursor: null,
    pendingInputs,
    queuePaused,
    queueRevision: 3,
    v2ThroughSeq: 0,
  };
}

function installV2(
  bootstrap: MobileV2ConversationBootstrap,
  conversationRef: ConversationRef = ref,
): void {
  const conversationKeyValue = conversationKey(conversationRef);
  reset({
    status: bootstrap.conversation.status,
    activeTurnId: bootstrap.conversation.activeTurnId,
  });
  useChatStore.setState({
    protocolByConversation: { [conversationKeyValue]: 'v2' as const },
    v2Projections: { [conversationKeyValue]: projectionFromBootstrap(bootstrap) },
    subscribedV2Conversations: { [conversationKeyValue]: conversationRef },
    openGenerationByConversation: { [conversationKeyValue]: 1 },
    projectionEpochByConversation: { [conversationKeyValue]: 1 },
  });
  mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap });
}

function userMessage(text: string): ConversationMessage {
  return {
    id: 'message-1',
    conversationId: ref.id,
    turnId: 'turn-1',
    ordinal: 1,
    role: 'user',
    status: 'completed',
    content: { type: 'user', text },
    createdAt: '2026-07-12T00:00:01Z',
    updatedAt: '2026-07-12T00:00:01Z',
  };
}

function assistantMessageWithChild(): ConversationMessage {
  return {
    id: 'message-2',
    conversationId: ref.id,
    turnId: 'turn-1',
    ordinal: 2,
    role: 'assistant',
    status: 'completed',
    content: {
      type: 'assistant',
      events: [
        {
          type: 'subagent_started',
          subagentId: 'sub_a',
          name: 'reviewer',
          subagentType: 'code-reviewer',
          description: 'Review the diff',
          prompt: 'Review it',
          background: true,
          depth: 1,
          startedAt: '2026-09-04T00:00:00.000Z',
        },
      ],
    },
    createdAt: '2026-07-12T00:00:02Z',
    updatedAt: '2026-07-12T00:00:02Z',
  } as ConversationMessage;
}

function repeatedChildV2Messages(): MobileV2ConversationMessage[] {
  const started = assistantMessageWithChild();
  return [
    {
      ...started,
      id: 'v2-child-start',
      turnId: 'run-start:segment',
      runId: 'run-start',
      segmentIndex: 0,
      deliveryKind: 'normal',
    },
    {
      id: 'v2-notification-prompt',
      conversationId: ref.id,
      turnId: 'run-notification:prompt',
      runId: 'run-notification',
      segmentIndex: 0,
      ordinal: 3,
      role: 'user',
      status: 'completed',
      deliveryKind: 'normal',
      origin: 'notification',
      content: {
        type: 'user',
        text: '<task-notification><task-id>sub_a</task-id></task-notification>',
      },
      createdAt: '2026-09-04T00:00:04.000Z',
      updatedAt: '2026-09-04T00:00:04.000Z',
    },
    {
      id: 'v2-child-finish',
      conversationId: ref.id,
      turnId: 'run-notification:segment',
      runId: 'run-notification',
      segmentIndex: 1,
      ordinal: 4,
      role: 'assistant',
      status: 'completed',
      deliveryKind: 'normal',
      content: {
        type: 'assistant',
        events: [
          {
            type: 'subagent_finished',
            subagentId: 'sub_a',
            name: 'reviewer',
            subagentType: 'code-reviewer',
            description: 'Review the diff',
            status: 'done',
            report: 'No blockers.',
            toolCallCount: 2,
            startedAt: '2026-09-04T00:00:00.000Z',
            endedAt: '2026-09-04T00:00:03.000Z',
          },
        ],
      },
      createdAt: '2026-09-04T00:00:05.000Z',
      updatedAt: '2026-09-04T00:00:05.000Z',
    },
  ] as MobileV2ConversationMessage[];
}

/**
 * A placeholder, replaced with a FRESH timestamp by `liveTurn`.
 *
 * It used to be `new Date(Date.now() - 65_000).toISOString()` evaluated at
 * module scope, which made the `1m` assertion below hold only while under 55 s
 * of wall clock separated the module being imported from that render — a
 * window the whole file shared. Measured margin was ~93x, so this is hygiene
 * rather than a fix for a flake anyone has seen. Fake timers are the wrong
 * tool: `useSubagentElapsed` runs a `setInterval` and this file waits with
 * `findBy*`/`waitFor`, so a fake clock buys a hang.
 */
const LIVE_STARTED_AT = 'live-started-at';

/** 65 s ago, as of NOW — so the window is one test's own duration. */
function freshStartedAt(): string {
  return new Date(Date.now() - 65_000).toISOString();
}

function subagentFrame(seq: number, event: Record<string, unknown>): MobileWsServerFrame {
  return {
    type: 'event',
    id: 'panel-turn',
    conversationId: ref.id,
    seq,
    event,
  } as unknown as MobileWsServerFrame;
}

const startedEvent = {
  type: 'subagent_started',
  subagentId: 'sub_a',
  name: 'reviewer',
  subagentType: 'code-reviewer',
  description: 'Review the diff',
  prompt: 'Review it',
  background: false,
  depth: 1,
  startedAt: LIVE_STARTED_AT,
};

const parkedEvent = {
  type: 'subagent_progress',
  subagentId: 'sub_a',
  status: 'waiting_input',
  question: 'Which branch?',
  toolCallCount: 3,
};

/** The panel's own turn, streaming: frames land in `streamingFrames[key]`. */
function liveTurn(events: Record<string, unknown>[]): void {
  const startedAt = freshStartedAt();
  const dated = events.map((event) =>
    event.startedAt === LIVE_STARTED_AT ? { ...event, startedAt } : event,
  );
  useChatStore.setState({
    messages: { [key]: [] },
    selectedConversationRef: { id: 'another-conversation', origin: 'gateway' },
    subagents: [],
    subagentUi: {},
    lastSeq: { [key]: events.length },
    streamingFrames: { [key]: dated.map((event, index) => subagentFrame(index + 1, event)) },
  });
}

/** The same fold, persisted: what the panel draws once the turn has ended. */
function persistedMessage(events: Record<string, unknown>[]): ConversationMessage {
  return {
    id: 'message-3',
    conversationId: ref.id,
    turnId: 'panel-turn',
    ordinal: 3,
    role: 'assistant',
    status: 'completed',
    content: { type: 'assistant', events },
    createdAt: '2026-07-12T00:00:03Z',
    updatedAt: '2026-07-12T00:00:03Z',
  } as ConversationMessage;
}

function reset(patch: Partial<McConversationView> = {}): void {
  useChatStore.setState({
    conversations: [{ ...conversation, ...patch }],
    conversationAuthority: 'gateway',
    gatewayOnline: true,
    messages: { [key]: [] },
    messageCursor: {},
    throughSeq: {},
    streamingFrames: {},
    localTurnIds: {},
    sending: {},
    protocolByConversation: {},
    v2Projections: {},
    subscribedV2Conversations: {},
    openingPromiseByConversation: {},
    openGenerationByConversation: {},
    projectionEpochByConversation: {},
    conversationOwnersByConversation: {},
    ordinarySendIntentsByConversation: {},
    pendingV2LegacyCommandsByConversation: {},
    commandIssuesByConversation: {},
    answerAttemptsByConversation: {},
    mainChatSurfaceGeneration: 0,
    mainChatSurfaceActive: false,
    mainChatSelectionGeneration: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState(originalActions);
  reset();
  mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
  mockApi.chatGetInitialState.mockResolvedValue({
    protocol: 'v1',
    page: { items: [], nextCursor: null, throughSeq: 0 },
  });
  mockApi.chatGetConversation.mockResolvedValue(conversation);
});

describe('SessionPanel', () => {
  it('loads and renders the canonical transcript through the exact ref', async () => {
    useChatStore.setState({ messages: {} });
    mockApi.chatGetMessages.mockResolvedValue({
      items: [userMessage('kickoff text')],
      nextCursor: null,
      throughSeq: 0,
    });
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v1',
      page: {
        items: [userMessage('kickoff text')],
        nextCursor: null,
        throughSeq: 0,
      },
    });

    render(<SessionPanel conversationRef={ref} />);

    expect(await screen.findByText('kickoff text')).toBeInTheDocument();
    expect(mockApi.chatGetInitialState).toHaveBeenCalledWith(ref);
  });

  it('sends a reply through the canonical chat action', async () => {
    useChatStore.setState({ messages: { [key]: [] } });
    mockApi.chatSend.mockImplementation(async (_ref, turnId) => ({
      type: 'accepted',
      id: turnId,
      conversationId: ref.id,
      userMessageId: 'canonical-user',
      assistantMessageId: 'canonical-assistant',
      revision: 3,
      seq: 1,
    }));
    render(<SessionPanel conversationRef={ref} />);

    const box = screen.getByPlaceholderText('Reply to the agent…');
    await userEvent.type(box, 'the goal is X{Enter}');

    await waitFor(() =>
      expect(mockApi.chatSend).toHaveBeenCalledWith(
        ref,
        expect.any(String),
        'the goal is X',
        undefined,
      ),
    );
    expect(screen.getByText('the goal is X')).toBeInTheDocument();
  });

  it('keeps cached transcript visible and locks the composer while offline', () => {
    reset({ offline: true, readOnly: true });
    useChatStore.setState({
      gatewayOnline: false,
      messages: { [key]: [userMessage('cached session')] },
    });

    render(<SessionPanel conversationRef={ref} />);

    expect(screen.getByText('cached session')).toBeInTheDocument();
    expect(
      screen.getByText('Gateway offline — cached conversations are read-only.'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Reconnect to send a message')).toBeDisabled();
  });

  it('keeps remote Stop and question answers enabled while send stays locked', async () => {
    reset({ status: 'running', activeTurnId: 'ios-turn' });
    const frame: MobileWsServerFrame = {
      type: 'event',
      id: 'ios-turn',
      conversationId: ref.id,
      seq: 1,
      event: { type: 'question', id: 'remote-question', question: 'Ship?', options: ['Yes'] },
    };
    useChatStore.setState({ streamingFrames: { [key]: [frame] } });

    render(<SessionPanel conversationRef={ref} />);

    expect(screen.getByText('Active on another device')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Conversation active on another device')).toBeDisabled();
    const stop = screen.getByLabelText('Cancel response');
    expect(stop).toBeEnabled();
    await userEvent.click(stop);
    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'ios-turn', expect.any(String));
    await userEvent.click(screen.getByText('Yes'));
    expect(mockApi.chatAnswerQuestion).toHaveBeenCalledWith(
      ref,
      'ios-turn',
      'remote-question',
      'Yes',
      expect.any(String),
    );
  });

  it('answers a question with the canonical active turn ID', async () => {
    reset({ status: 'running', activeTurnId: 'local-turn' });
    const frame: MobileWsServerFrame = {
      type: 'event',
      id: 'local-turn',
      conversationId: ref.id,
      seq: 1,
      event: { type: 'question', id: 'question-1', question: 'Ship?', options: ['Yes'] },
    };
    useChatStore.setState({
      streamingFrames: { [key]: [frame] },
      localTurnIds: { [key]: 'local-turn' },
    });

    render(<SessionPanel conversationRef={ref} />);
    await userEvent.click(screen.getByText('Yes'));

    expect(mockApi.chatAnswerQuestion).toHaveBeenCalledWith(
      ref,
      'local-turn',
      'question-1',
      'Yes',
      expect.any(String),
    );
  });

  // The chat store's `subagents` / `subagentUi` describe the conversation the
  // CHAT route has selected. This panel draws a different one, so its cards
  // read the fold and offer nothing: a stop or a resume from here addresses
  // the child correctly and then refreshes the other conversation's list, so
  // the row the user is looking at never moves.
  it('draws a sub-agent card in a session transcript from the fold, with no actions', async () => {
    const message = assistantMessageWithChild();
    mockApi.chatGetInitialState.mockResolvedValue({
      protocol: 'v1',
      page: { items: [message], nextCursor: null, throughSeq: 0 },
    });
    useChatStore.setState({
      messages: { [key]: [message] },
      selectedConversationRef: { id: 'another-conversation', origin: 'gateway' },
      subagents: [
        {
          id: 'sub_a',
          type: 'code-reviewer',
          description: 'Review the diff',
          status: 'done',
          background: false,
          depth: 1,
          startedAt: '2026-09-04T00:00:00.000Z',
          toolCallCount: 12,
          oneShot: true,
        },
      ],
      subagentUi: {},
    });

    render(<SessionPanel conversationRef={ref} />);

    const card = await screen.findByTestId('subagent-card-sub_a');
    expect(card).toHaveAttribute('data-status', 'running');
    expect(screen.queryByTestId('subagent-card-toggle-sub_a')).not.toBeInTheDocument();
    // …and it says so: nothing here is live, so the card is a snapshot.
    expect(screen.getByTestId('subagent-card-snapshot-sub_a')).toBeInTheDocument();
  });

  it('reconciles repeated child events in a v2 session and keeps its card interactive', async () => {
    const messages = repeatedChildV2Messages();
    installV2(v2Bootstrap(conversation, { activeTurnId: null, messages }));
    useChatStore.setState({
      selectedConversationRef: ref,
      subagents: [
        {
          id: 'sub_a',
          type: 'code-reviewer',
          description: 'Review the diff',
          status: 'done',
          background: true,
          depth: 1,
          startedAt: '2026-09-04T00:00:00.000Z',
          endedAt: '2026-09-04T00:00:03.000Z',
          toolCallCount: 2,
          oneShot: false,
        },
      ],
      subagentUi: {},
    });

    render(<SessionPanel conversationRef={ref} />);

    expect(await screen.findAllByTestId('subagent-card-toggle-sub_a')).toHaveLength(1);
    expect(screen.getByTestId('notification-row')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));
    await waitFor(() => expect(mockApi.conversationMessages).toHaveBeenCalledWith('sub_a'));
  });

  // …but a card on a STREAMING message has a live source even off the
  // selection, and the round-2 snapshot must not reach it. `ensureMessages`
  // makes main subscribe this conversation when it is running
  // (`ChatService.getMessages`, `chat-service.ts:452-459`) and `applyFrame`
  // writes `streamingFrames[key]` for ANY conversation id, ungated by the
  // selection (its two `set` calls, `stores/chat.ts:938` and `:956`). The fold under this bubble moves in real time, so the clock, the
  // spinner and §8.1's collapsed-row question all belong here — and the card
  // has no expand toggle, so hiding the question hides it from this screen
  // entirely.
  it('keeps a streaming sub-agent card live off the selected conversation', async () => {
    liveTurn([startedEvent, parkedEvent]);

    render(<SessionPanel conversationRef={ref} />);

    const card = await screen.findByTestId('subagent-card-sub_a');
    expect(card).toHaveAttribute('data-status', 'waiting');
    expect(screen.getByTestId('subagent-question-sub_a')).toHaveTextContent('Which branch?');
    // Scoped to the CARD: the bubble draws its own streaming spinner too.
    expect(card.querySelector('.animate-spin')).not.toBeNull();
    expect(within(card).getByTestId('subagent-card-meta')).toHaveTextContent(/3 tool uses · 1m/);
    expect(screen.queryByTestId('subagent-card-snapshot-sub_a')).not.toBeInTheDocument();
    // Live, but still not this conversation's list: no actions, no reply box.
    expect(screen.queryByTestId('subagent-card-toggle-sub_a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subagent-reply-input-sub_a')).not.toBeInTheDocument();
  });

  // D1's rule, on the path this round widens: a child that parks on a question
  // and then finishes during the same live turn must not keep the question on
  // a terminal row. Three separate paths have broken this before.
  it("drops a streaming card's question the moment the child finishes", async () => {
    liveTurn([
      startedEvent,
      parkedEvent,
      {
        type: 'subagent_finished',
        subagentId: 'sub_a',
        status: 'completed',
        toolCallCount: 4,
        startedAt: LIVE_STARTED_AT,
        endedAt: new Date(Date.now() - 5_000).toISOString(),
      },
    ]);

    render(<SessionPanel conversationRef={ref} />);

    const card = await screen.findByTestId('subagent-card-sub_a');
    expect(card).toHaveAttribute('data-status', 'done');
    expect(screen.queryByTestId('subagent-question-sub_a')).not.toBeInTheDocument();
    expect(card.querySelector('.animate-spin')).toBeNull();
    expect(screen.queryByTestId('subagent-card-snapshot-sub_a')).not.toBeInTheDocument();
  });

  // The boundary the liveness gate creates, driven rather than staged: the
  // panel's turn ends, `refreshTerminal` empties `streamingFrames[key]` and
  // merges the persisted message, and the very same card must become the
  // snapshot round 2 made it — with no question surviving onto the terminal
  // row the end of the stream produces.
  it('turns the card into a snapshot when the panel turn ends', async () => {
    liveTurn([startedEvent, parkedEvent]);
    mockApi.chatGetConversation.mockResolvedValue(conversation);

    render(<SessionPanel conversationRef={ref} />);
    expect(await screen.findByTestId('subagent-question-sub_a')).toBeInTheDocument();

    mockApi.chatGetMessages.mockResolvedValue({
      items: [persistedMessage([startedEvent, parkedEvent])],
      nextCursor: null,
      throughSeq: 3,
    });
    await act(async () => {
      await useChatStore.getState().applyFrame({
        type: 'done',
        id: 'panel-turn',
        conversationId: ref.id,
        seq: 3,
      } as MobileWsServerFrame);
    });

    const card = await screen.findByTestId('subagent-card-sub_a');
    // End-of-stream terminalization: a non-background child with no terminal
    // event is `cancelled`, and a dead child carries no question.
    expect(card).toHaveAttribute('data-status', 'cancelled');
    expect(screen.queryByTestId('subagent-question-sub_a')).not.toBeInTheDocument();
    expect(card.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('subagent-card-snapshot-sub_a')).toBeInTheDocument();
    expect(within(card).getByTestId('subagent-card-meta')).toHaveTextContent('3 tool uses');
    expect(within(card).getByTestId('subagent-card-meta')).not.toHaveTextContent('·');
  });

  it('keeps read-only local history visible without enabling mutations', () => {
    const localRef = { id: ref.id, origin: 'local' as const };
    const localKey = conversationKey(localRef);
    reset({ origin: 'local', readOnly: true });
    useChatStore.setState({ messages: { [localKey]: [userMessage('legacy history')] } });

    render(<SessionPanel conversationRef={localRef} />);

    expect(screen.getByText('legacy history')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('This conversation is read-only')).toBeDisabled();
  });

  it('enables active queue input only for a capable gateway conversation', async () => {
    const bootstrap = v2Bootstrap({ ...conversation, status: 'running', activeTurnId: 'run-1' });
    installV2(bootstrap);
    const capable = render(<SessionPanel conversationRef={ref} />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel response')).toBeInTheDocument();

    capable.unmount();
    await waitFor(() => expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledWith(ref));

    const localRef = { id: ref.id, origin: 'local' as const };
    const localKey = conversationKey(localRef);
    reset({ origin: 'local', status: 'running', activeTurnId: 'run-1' });
    useChatStore.setState({
      protocolByConversation: { [localKey]: 'v1' as const },
      messages: { [localKey]: [] },
    });
    render(<SessionPanel conversationRef={localRef} />);

    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cancel response')).toBeInTheDocument();
  });

  it('shares FIFO queue, attachment editing, and the active-response chooser', async () => {
    const first = followUp('first', 1, {
      images: [{ mediaType: 'image/png', data: 'b2xk' }],
    });
    const second = followUp('second', 2);
    installV2(
      v2Bootstrap(
        { ...conversation, status: 'running', activeTurnId: 'run-1' },
        { pendingInputs: [second, first] },
      ),
    );
    const enqueueInput = vi.fn(async () => followUp('acknowledged', 3));
    const editFollowUp = vi.fn(async () => ({ ...first, revision: 2 }));
    useChatStore.setState({ enqueueInput, editFollowUp });
    render(<SessionPanel conversationRef={ref} />);

    const cards = screen.getAllByRole('article');
    expect(cards[0]).toHaveAccessibleName('Follow Up, position 1 of 2');
    expect(cards[0]).toHaveTextContent('Follow up 1');
    expect(cards[1]).toHaveTextContent('Follow up 2');

    await userEvent.type(screen.getByLabelText('Message'), 'send after this');
    await userEvent.upload(
      screen.getByLabelText('Attach images'),
      new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' }),
    );
    await screen.findByAltText('Attachment 1');
    await userEvent.click(screen.getByLabelText('Send message'));
    expect(screen.getByRole('dialog', { name: 'A response is in progress' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText('Message')).toHaveValue('send after this');
    expect(screen.getByAltText('Attachment 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveFocus();

    await userEvent.click(screen.getByLabelText('Send message'));
    await userEvent.click(screen.getByRole('button', { name: 'Follow Up' }));
    await waitFor(() => expect(enqueueInput).toHaveBeenCalledTimes(1));
    expect(enqueueInput).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({
        behavior: 'followUp',
        text: 'send after this',
        images: [expect.objectContaining({ mediaType: 'image/png' })],
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue(''));

    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 2'));
    await userEvent.click(screen.getByLabelText('Remove editor attachment 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([4, 5, 6])], 'replacement.png', { type: 'image/png' }),
    );
    await screen.findByAltText('Editor attachment 1');
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));
    await waitFor(() => expect(editFollowUp).toHaveBeenCalledTimes(1));
    expect(editFollowUp).toHaveBeenCalledWith(ref, 'first', 1, 'Follow up 1', [
      expect.objectContaining({ mediaType: 'image/png' }),
    ]);
  });

  it('keeps v2 answers tentative through unrelated events and rejection', async () => {
    installV2(
      v2Bootstrap(
        { ...conversation, status: 'running', activeTurnId: 'run-1' },
        { messages: [questionMessage()] },
      ),
    );
    render(<SessionPanel conversationRef={ref} />);
    await waitFor(() =>
      expect(useChatStore.getState().conversationOwnersByConversation[key]?.length).toBe(1),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(screen.getByText('Answer sent — waiting for response')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();

    await act(async () => {
      await useChatStore.getState().applyV2Frame({
        type: 'event',
        id: 'run-1',
        conversationId: ref.id,
        runId: 'run-1',
        segmentTurnId: 'segment-1',
        v2Seq: 1,
        event: { type: 'text_delta', text: 'Still working.' },
      });
    });
    expect(screen.getByText('Answer sent — waiting for response')).toBeInTheDocument();

    const localDispatchToken = Object.keys(
      useChatStore.getState().pendingV2LegacyCommandsByConversation[key] ?? {},
    )[0];
    expect(localDispatchToken).toBeDefined();
    act(() => {
      useChatStore.getState().handleV2CommandIssue({
        conversation: ref,
        commandId: 'run-1',
        kind: 'answer',
        localDispatchToken: localDispatchToken as string,
        questionId: 'question-1',
        ambiguousCorrelation: false,
        apiError: {
          code: 'validation_failed',
          error: 'The answer was stale.',
          retryable: false,
        },
      });
    });
    expect(screen.getByRole('button', { name: 'Retry answer: Yes' })).toBeInTheDocument();
    expect(screen.getByText('The answer was stale.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('The answer was stale.')).not.toBeInTheDocument();
    expect(screen.getByText(/Answer was not delivered: Yes/)).toBeInTheDocument();
  });

  it.each([
    ['completed', { type: 'done', outcome: 'completed' }],
    ['cancelled', { type: 'done', outcome: 'cancelled' }],
    ['failed/error', { type: 'error', error: 'Provider failed', retryable: false }],
  ] as const)(
    'renders a %s answer terminal neutrally in a session panel',
    async (_label, terminal) => {
      installV2(
        v2Bootstrap(
          { ...conversation, status: 'running', activeTurnId: 'run-1' },
          { messages: [questionMessage()] },
        ),
      );
      const { container } = render(<SessionPanel conversationRef={ref} />);
      await waitFor(() =>
        expect(useChatStore.getState().conversationOwnersByConversation[key]?.length).toBe(1),
      );

      await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
      expect(screen.getByText('Answer sent — waiting for response')).toBeInTheDocument();

      await act(async () => {
        await useChatStore.getState().applyV2Frame({
          ...terminal,
          id: 'run-1',
          conversationId: ref.id,
          runId: 'run-1',
          segmentTurnId: 'segment-1',
          v2Seq: 1,
        });
      });

      const ended = screen.getByText('Interaction ended');
      expect(ended.parentElement).toHaveTextContent('Yes');
      expect(screen.queryByText('✓')).not.toBeInTheDocument();
      expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    },
  );

  it('keeps attempted answer context when a terminal arrives before the assistant write', async () => {
    installV2(v2Bootstrap({ ...conversation, status: 'running', activeTurnId: 'run-1' }));
    const { container } = render(<SessionPanel conversationRef={ref} />);
    await waitFor(() =>
      expect(useChatStore.getState().conversationOwnersByConversation[key]?.length).toBe(1),
    );

    await act(async () => {
      await useChatStore.getState().applyV2Frame({
        type: 'event',
        id: 'run-1',
        conversationId: ref.id,
        runId: 'run-1',
        segmentTurnId: 'segment-1',
        v2Seq: 1,
        event: {
          type: 'question',
          id: 'question-1',
          question: 'Ship?',
          options: ['Yes', 'No'],
        },
      });
    });
    expect(Object.keys(useChatStore.getState().v2Projections[key].messages)).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));

    await act(async () => {
      await useChatStore.getState().applyV2Frame({
        type: 'done',
        id: 'run-1',
        conversationId: ref.id,
        runId: 'run-1',
        segmentTurnId: 'segment-1',
        v2Seq: 2,
        outcome: 'completed',
      });
    });

    const ended = screen.getByText('Interaction ended');
    expect(ended.parentElement).toHaveTextContent('Yes');
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('keeps one stable owner across equivalent ref objects and releases the exact ref', async () => {
    reset({ status: 'running', activeTurnId: 'run-1' });
    const bootstrap = v2Bootstrap({ ...conversation, status: 'running', activeTurnId: 'run-1' });
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap });
    const panel = render(<SessionPanel conversationRef={{ ...ref }} />);

    await waitFor(() => expect(mockApi.chatSubscribeV2).toHaveBeenCalledWith(ref, 0));
    const [owner] = useChatStore.getState().conversationOwnersByConversation[key] ?? [];
    expect(owner).toMatch(/^session-panel:/);

    panel.rerender(<SessionPanel conversationRef={{ ...ref }} />);
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual([owner]);
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledTimes(1);

    panel.unmount();
    await waitFor(() => expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledWith(ref));
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toBeUndefined();
  });

  it.each([
    ['ordinary Send', false],
    ['Follow Up', true],
  ] as const)(
    'keeps switched and newer attachment drafts after a late %s acknowledgement',
    async (_label, queued) => {
      const secondRef: ConversationRef = { id: 'conv-84', origin: 'gateway' };
      const secondKey = conversationKey(secondRef);
      const firstView = {
        ...conversation,
        status: queued ? ('running' as const) : ('idle' as const),
        activeTurnId: queued ? 'run-1' : null,
      };
      const secondView: McConversationView = {
        ...firstView,
        id: secondRef.id,
        title: 'Second session',
      };
      reset(firstView);
      useChatStore.setState({ conversations: [firstView, secondView] });

      if (queued) {
        const firstBootstrap = v2Bootstrap(firstView);
        const secondBootstrap = v2Bootstrap(secondView);
        useChatStore.setState({
          protocolByConversation: {
            [key]: 'v2' as const,
            [secondKey]: 'v2' as const,
          },
          v2Projections: {
            [key]: projectionFromBootstrap(firstBootstrap),
            [secondKey]: projectionFromBootstrap(secondBootstrap),
          },
          subscribedV2Conversations: { [key]: ref, [secondKey]: secondRef },
          conversationOwnersByConversation: { [key]: ['overlap'], [secondKey]: ['overlap'] },
          openGenerationByConversation: { [key]: 1, [secondKey]: 1 },
          projectionEpochByConversation: { [key]: 1, [secondKey]: 1 },
        });
        mockApi.chatGetInitialState.mockImplementation(async (requestedRef) => ({
          protocol: 'v2',
          bootstrap: requestedRef.id === ref.id ? firstBootstrap : secondBootstrap,
        }));
      } else {
        useChatStore.setState({
          protocolByConversation: {
            [key]: 'v1' as const,
            [secondKey]: 'v1' as const,
          },
          messages: { [key]: [], [secondKey]: [] },
        });
      }

      let acknowledge!: () => void;
      const pending = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const sendMessage = vi.fn(async (..._args: Parameters<ChatState['sendMessage']>) => pending);
      const enqueueInput = vi.fn(async (..._args: Parameters<ChatState['enqueueInput']>) => {
        await pending;
        return followUp('late-ack', 1);
      });
      useChatStore.setState({ sendMessage, enqueueInput });
      const panel = render(<SessionPanel conversationRef={ref} />);

      await userEvent.type(screen.getByLabelText('Message'), 'draft A');
      await userEvent.upload(
        screen.getByLabelText('Attach images'),
        new File([new Uint8Array([1])], 'first.png', { type: 'image/png' }),
      );
      await screen.findByAltText('Attachment 1');
      await userEvent.click(screen.getByLabelText('Send message'));
      if (queued) await userEvent.click(screen.getByRole('button', { name: 'Follow Up' }));

      await userEvent.type(screen.getByLabelText('Message'), ' newer');
      await userEvent.click(screen.getByLabelText('Remove attachment 1'));
      await userEvent.upload(
        screen.getByLabelText('Attach images'),
        new File([new Uint8Array([2])], 'newer.png', { type: 'image/png' }),
      );
      const newerPreview = (await screen.findByAltText('Attachment 1')).getAttribute('src');

      panel.rerender(<SessionPanel conversationRef={secondRef} />);
      await userEvent.type(screen.getByLabelText('Message'), 'draft B');
      await userEvent.upload(
        screen.getByLabelText('Attach images'),
        new File([new Uint8Array([3])], 'second.png', { type: 'image/png' }),
      );
      expect(await screen.findByAltText('Attachment 1')).toBeInTheDocument();

      acknowledge();
      await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('draft B'));
      panel.rerender(<SessionPanel conversationRef={ref} />);
      expect(screen.getByLabelText('Message')).toHaveValue('draft A newer');
      expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(newerPreview);
      const action = queued ? enqueueInput : sendMessage;
      expect(action.mock.calls[0]?.[0]).toEqual(ref);
    },
  );
});
