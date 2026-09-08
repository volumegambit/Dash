import '@testing-library/jest-dom/vitest';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../../vitest.setup.js';
import { conversationKey, useChatStore } from '../../../stores/chat.js';
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
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
  mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
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

    render(<SessionPanel conversationRef={ref} />);

    expect(await screen.findByText('kickoff text')).toBeInTheDocument();
    expect(mockApi.chatGetMessages).toHaveBeenCalledWith(ref, undefined);
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
    const stop = screen.getByLabelText('Stop active turn');
    expect(stop).toBeEnabled();
    await userEvent.click(stop);
    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'ios-turn');
    await userEvent.click(screen.getByText('Yes'));
    expect(mockApi.chatAnswerQuestion).toHaveBeenCalledWith(
      ref,
      'ios-turn',
      'remote-question',
      'Yes',
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

    expect(mockApi.chatAnswerQuestion).toHaveBeenCalledWith(ref, 'local-turn', 'question-1', 'Yes');
  });

  // The chat store's `subagents` / `subagentUi` describe the conversation the
  // CHAT route has selected. This panel draws a different one, so its cards
  // read the fold and offer nothing: a stop or a resume from here addresses
  // the child correctly and then refreshes the other conversation's list, so
  // the row the user is looking at never moves.
  it('draws a sub-agent card in a session transcript from the fold, with no actions', async () => {
    useChatStore.setState({
      messages: { [key]: [assistantMessageWithChild()] },
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
});
