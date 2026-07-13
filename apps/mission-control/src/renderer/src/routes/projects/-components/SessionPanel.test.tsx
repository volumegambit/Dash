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

  it('answers a remote question while send and cancel stay locked', async () => {
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
    expect(screen.queryByLabelText('Stop active turn')).toBeNull();
    await userEvent.click(screen.getByText('Yes'));
    expect(mockApi.chatAnswerQuestion).toHaveBeenCalledWith(
      ref,
      'ios-turn',
      'remote-question',
      'Yes',
    );
    expect(mockApi.chatCancel).not.toHaveBeenCalled();
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
