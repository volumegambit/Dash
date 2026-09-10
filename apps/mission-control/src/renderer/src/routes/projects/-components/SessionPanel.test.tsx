import '@testing-library/jest-dom/vitest';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2PendingInput,
} from '@dash/mobile-contract-v2';
import { act, render, screen, waitFor } from '@testing-library/react';
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
