import '@testing-library/jest-dom/vitest';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import type { McAgentEvent } from '../../../shared/ipc.js';
import { useAgentsStore } from '../stores/agents.js';
import { conversationKey, useChatStore } from '../stores/chat.js';

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const mockUseSearch = vi.fn().mockReturnValue({ agentId: '' });
const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    component: opts.component,
    useSearch: mockUseSearch,
  }),
  useNavigate: () => mockNavigate,
}));

const { Chat, MessageBubble } = await import('./chat.js');

const agent1 = {
  id: 'agent-1',
  name: 'Developer',
  status: 'active' as const,
  registeredAt: new Date().toISOString(),
  config: { model: 'claude-sonnet-4-6', systemPrompt: '' },
};

const agent2 = {
  id: 'agent-2',
  name: 'Assistant',
  status: 'active' as const,
  registeredAt: new Date().toISOString(),
  config: { model: 'claude-sonnet-4-6', systemPrompt: '' },
};

const gatewayConversation: McConversationView = {
  id: 'shared-id',
  agentId: agent1.id,
  agentName: agent1.name,
  title: 'Gateway conversation',
  revision: 2,
  status: 'idle',
  activeTurnId: null,
  owningIssueId: null,
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: 'cached transcript',
  createdAt: '2026-07-12T00:00:00Z',
  updatedAt: '2026-07-12T00:00:02Z',
  origin: 'gateway',
  offline: false,
  readOnly: false,
};

const localConversation: McConversationView = {
  ...gatewayConversation,
  agentName: 'Local Developer',
  title: 'Local conversation',
  origin: 'local',
  updatedAt: '2026-07-12T00:00:01Z',
};

function canonicalMessage(ref: ConversationRef, text = 'cached transcript'): ConversationMessage {
  return {
    id: `${ref.origin}-message`,
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

function setCanonicalState(
  conversations: McConversationView[],
  selectedConversationRef: ConversationRef | null = null,
): void {
  useChatStore.setState({
    conversations,
    nextConversationCursor: null,
    conversationAuthority: 'gateway',
    gatewayOnline: true,
    selectedConversationRef,
    openTabKeys: selectedConversationRef ? [conversationKey(selectedConversationRef)] : [],
    messages: {},
    messageCursor: {},
    throughSeq: {},
    streamingFrames: {},
    lastSeq: {},
    localTurnIds: {},
    sending: {},
    unreadConversations: new Set(),
    conversationError: null,
  });
  mockApi.chatListConversations.mockResolvedValue({
    items: conversations,
    nextCursor: null,
    authority: 'gateway',
    gatewayOnline: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSearch.mockReturnValue({ agentId: '' });
  mockNavigate.mockClear();
  useAgentsStore.setState({ agents: [agent1], loading: false, error: null });
  setCanonicalState([]);
  mockApi.agentsList.mockResolvedValue([agent1]);
  mockApi.chatListConversations.mockResolvedValue({
    items: [],
    nextCursor: null,
    authority: 'gateway',
    gatewayOnline: true,
  });
  mockApi.chatGetConversation.mockResolvedValue(null);
  mockApi.chatGetMessages.mockResolvedValue({ items: [], nextCursor: null, throughSeq: 0 });
});

describe('Chat search params', () => {
  it('creates a conversation for the agent passed via search params', async () => {
    useAgentsStore.setState({
      agents: [agent2, agent1],
      loading: false,
      error: null,
    });
    mockUseSearch.mockReturnValue({ agentId: 'agent-1' });
    mockApi.chatCreateConversation.mockResolvedValue(gatewayConversation);
    render(<Chat />);
    await vi.waitFor(() => {
      expect(mockApi.chatCreateConversation).toHaveBeenCalledWith('agent-1', expect.any(String));
    });
  });

  it('selects an exact-origin conversation outside the first page', async () => {
    useAgentsStore.setState({ agents: [agent1], loading: false, error: null });
    const deep = { ...gatewayConversation, id: 'conv-page-51' };
    mockUseSearch.mockReturnValue({
      agentId: '',
      conversationId: deep.id,
      origin: 'gateway',
    });
    mockApi.chatGetConversation.mockResolvedValue(deep);
    render(<Chat />);
    await vi.waitFor(() => {
      expect(useChatStore.getState().selectedConversationRef).toEqual({
        id: deep.id,
        origin: 'gateway',
      });
    });
    expect(mockApi.chatGetConversation).toHaveBeenCalledWith({ id: deep.id, origin: 'gateway' });
    expect(mockApi.chatCreateConversation).not.toHaveBeenCalled();
  });

  it('shows not found for a missing exact-origin link without creating a replacement', async () => {
    mockUseSearch.mockReturnValue({
      agentId: '',
      conversationId: 'missing',
      origin: 'gateway',
    });
    mockApi.chatGetConversation.mockResolvedValue(null);

    render(<Chat />);

    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
    expect(mockApi.chatCreateConversation).not.toHaveBeenCalled();
  });

  it('purges a deleted exact-origin deep link and shows not found', async () => {
    mockUseSearch.mockReturnValue({
      agentId: '',
      conversationId: gatewayConversation.id,
      origin: 'gateway',
    });
    mockApi.chatGetConversation.mockResolvedValue({
      ...gatewayConversation,
      status: 'deleted',
      deletedAt: '2026-07-12T00:00:03Z',
    });

    render(<Chat />);

    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
    expect(useChatStore.getState().conversations).toEqual([]);
  });

  it('selects the sole exact match for an old link without an origin', async () => {
    mockUseSearch.mockReturnValue({ agentId: '', conversationId: gatewayConversation.id });
    mockApi.chatGetConversation.mockImplementation(async (ref: ConversationRef) =>
      ref.origin === 'gateway' ? gatewayConversation : null,
    );

    render(<Chat />);

    await waitFor(() =>
      expect(useChatStore.getState().selectedConversationRef).toEqual({
        id: gatewayConversation.id,
        origin: 'gateway',
      }),
    );
  });

  it('requires an origin choice when an old link matches gateway and local history', async () => {
    mockUseSearch.mockReturnValue({ agentId: '', conversationId: 'shared-id' });
    mockApi.chatGetConversation.mockImplementation(async (ref: ConversationRef) =>
      ref.origin === 'gateway' ? gatewayConversation : localConversation,
    );

    render(<Chat />);

    expect(await screen.findByText('Choose Gateway or On this Mac')).toBeInTheDocument();
    expect(useChatStore.getState().selectedConversationRef).toBeNull();
  });
});

describe('canonical conversation UI', () => {
  it('groups local history under On this Mac only in capable mode', async () => {
    setCanonicalState([gatewayConversation, localConversation]);
    mockApi.chatListConversations.mockResolvedValue({
      items: [gatewayConversation, localConversation],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });
    render(<Chat />);

    await userEvent.click(screen.getByLabelText('Browse conversations'));

    expect(screen.getByText('On this Mac')).toBeInTheDocument();
    const browser = within(screen.getByTestId('conversation-browser-list'));
    expect(browser.getByText(gatewayConversation.title)).toBeInTheDocument();
    expect(browser.getByText(localConversation.title)).toBeInTheDocument();
  });

  it('does not show the On this Mac header in explicit legacy mode', async () => {
    useChatStore.setState({
      conversations: [localConversation],
      conversationAuthority: 'legacy',
      gatewayOnline: true,
    });
    mockApi.chatListConversations.mockResolvedValue({
      items: [localConversation],
      nextCursor: null,
      authority: 'legacy',
      gatewayOnline: true,
    });
    render(<Chat />);

    await userEvent.click(screen.getByLabelText('Browse conversations'));

    expect(screen.queryByText('On this Mac')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('conversation-browser-list')).getByText(localConversation.title),
    ).toBeInTheDocument();
  });

  it('loads the next gateway conversation page from the browser', async () => {
    setCanonicalState([gatewayConversation]);
    useChatStore.setState({ nextConversationCursor: 'page-2' });
    mockApi.chatListConversations
      .mockResolvedValueOnce({
        items: [gatewayConversation],
        nextCursor: 'page-2',
        authority: 'gateway',
        gatewayOnline: true,
      })
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null,
        authority: 'gateway',
        gatewayOnline: true,
      });
    render(<Chat />);
    await userEvent.click(screen.getByLabelText('Browse conversations'));

    await userEvent.click(screen.getByText('Load more conversations'));

    expect(mockApi.chatListConversations).toHaveBeenLastCalledWith('page-2');
  });

  it('selects the requested origin when gateway and local rows share an ID', async () => {
    setCanonicalState([gatewayConversation, localConversation]);
    mockApi.chatListConversations.mockResolvedValue({
      items: [gatewayConversation, localConversation],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });
    mockApi.chatGetConversation.mockImplementation(async (ref: ConversationRef) =>
      ref.origin === 'gateway' ? gatewayConversation : localConversation,
    );
    render(<Chat />);
    await userEvent.click(screen.getByLabelText('Browse conversations'));

    await userEvent.click(
      within(screen.getByTestId('conversation-browser-list')).getByText(localConversation.title),
    );

    expect(useChatStore.getState().selectedConversationRef).toEqual({
      id: localConversation.id,
      origin: 'local',
    });
  });

  it('keeps cached content visible and disables every mutation while offline', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const offline = { ...gatewayConversation, offline: true, readOnly: true };
    setCanonicalState([offline], ref);
    useChatStore.setState({
      gatewayOnline: false,
      messages: { [conversationKey(ref)]: [canonicalMessage(ref)] },
    });
    mockApi.chatListConversations.mockRejectedValue({ code: 'gateway_offline' });

    render(<Chat />);

    expect(
      screen.getByText('Gateway offline — cached conversations are read-only.'),
    ).toBeInTheDocument();
    expect(screen.getByText('cached transcript')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Reconnect to send a message')).toBeDisabled();
    expect(screen.getByLabelText('New conversation')).toBeDisabled();
    expect(screen.getByTestId('status-bar-rename')).toBeDisabled();
    expect(screen.getByTestId('status-bar-delete')).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Browse conversations'));
    expect(screen.getByText('Cached')).toBeInTheDocument();
  });

  it('shows replayed output and locks the composer when another device owns the turn', () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const running = {
      ...gatewayConversation,
      status: 'running' as const,
      activeTurnId: 'ios-turn',
    };
    const eventFrame: MobileWsServerFrame = {
      type: 'event',
      id: 'ios-turn',
      conversationId: ref.id,
      seq: 1,
      event: { type: 'text_delta', text: 'replayed from iOS' },
    };
    setCanonicalState([running], ref);
    useChatStore.setState({ streamingFrames: { [conversationKey(ref)]: [eventFrame] } });

    render(<Chat />);

    expect(screen.getByText('Active on another device')).toBeInTheDocument();
    expect(screen.getByText(/replayed from iOS/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Conversation active on another device')).toBeDisabled();
    expect(screen.getByTestId('status-bar-rename')).toBeDisabled();
    expect(screen.getByTestId('status-bar-delete')).toBeDisabled();
  });

  it('keeps Stop for a locally owned canonical turn while rename and delete stay locked', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const running = {
      ...gatewayConversation,
      status: 'running' as const,
      activeTurnId: 'local-turn',
    };
    setCanonicalState([running], ref);
    useChatStore.setState({
      localTurnIds: { [conversationKey(ref)]: 'local-turn' },
      sending: { [conversationKey(ref)]: true },
    });

    render(<Chat />);
    await userEvent.click(screen.getByLabelText('Stop active turn'));

    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'local-turn');
    expect(screen.getByTestId('status-bar-rename')).toBeDisabled();
    expect(screen.getByTestId('status-bar-delete')).toBeDisabled();
  });

  it('keeps archived history readable and marks it archived while locking mutations', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const archived = { ...gatewayConversation, status: 'archived' as const };
    setCanonicalState([archived], ref);
    useChatStore.setState({ messages: { [conversationKey(ref)]: [canonicalMessage(ref)] } });

    render(<Chat />);

    expect(screen.getByText('cached transcript')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('This conversation is read-only')).toBeDisabled();
    expect(screen.getByTestId('status-bar-rename')).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Browse conversations'));
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('passes the canonical revision for idle rename and delete actions', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    setCanonicalState([gatewayConversation], ref);
    mockApi.chatRenameConversation.mockResolvedValue({
      ...gatewayConversation,
      title: 'Renamed conversation',
      revision: 3,
    });
    render(<Chat />);

    await userEvent.click(screen.getByTestId('status-bar-rename'));
    const input = screen.getByTestId('status-bar-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed conversation{Enter}');
    expect(mockApi.chatRenameConversation).toHaveBeenCalledWith(
      ref,
      gatewayConversation.revision,
      'Renamed conversation',
    );

    await userEvent.click(screen.getByTestId('status-bar-delete'));
    await userEvent.click(screen.getByTestId('status-bar-confirm-delete'));
    expect(mockApi.chatDeleteConversation).toHaveBeenCalledWith(ref, 3);
  });
});

describe('MessageBubble unresolved tool calls', () => {
  const toolStart = {
    type: 'tool_use_start',
    id: 't1',
    name: 'wait_workers',
    input: {},
  } satisfies McAgentEvent;

  function assistantMessage(events: Record<string, unknown>[]) {
    return {
      id: 'm1',
      role: 'assistant' as const,
      content: { type: 'assistant' as const, events },
      timestamp: '2026-07-06T00:00:00Z',
    };
  }

  it('shows a spinner for an unresolved tool call while streaming', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage([])} streamingEvents={[toolStart]} />,
    );
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.textContent).not.toContain('interrupted');
  });

  it('renders an unresolved tool call as interrupted (no spinner) from history', () => {
    const { container } = render(<MessageBubble message={assistantMessage([toolStart])} />);
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.textContent).toContain('interrupted');
    expect(container.querySelector('.lucide-ban')).not.toBeNull();
  });

  it('renders an unknown canonical event as neutral newer-version activity', () => {
    render(
      <MessageBubble
        message={assistantMessage([{ type: 'future_gateway_activity', payload: 'private' }])}
      />,
    );

    expect(screen.getByText('Activity from a newer Dash version')).toBeInTheDocument();
    expect(screen.queryByText('private')).not.toBeInTheDocument();
  });
});

describe('MessageBubble auto-retry rendering', () => {
  function assistantMessage(events: Record<string, unknown>[]) {
    return {
      id: 'm1',
      role: 'assistant' as const,
      content: { type: 'assistant' as const, events },
      timestamp: '2026-07-06T00:00:00Z',
    };
  }

  const transientError = {
    type: 'error',
    error: 'Request timed out.',
    timestamp: '2026-07-06T00:00:01Z',
  } satisfies McAgentEvent;

  const retry = {
    type: 'agent_retry',
    attempt: 1,
    reason: 'Request timed out.',
  } satisfies McAgentEvent;

  it('folds a transient error into a retry notice when agent_retry follows', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage([])} streamingEvents={[transientError, retry]} />,
    );
    expect(container.textContent).toContain('Retrying (attempt 1)');
    // The superseded error must not render as a terminal red error block
    expect(container.querySelector('.text-red')).toBeNull();
  });

  it('still renders a terminal error red when no retry follows', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage([])} streamingEvents={[transientError]} />,
    );
    expect(container.querySelector('.text-red')).not.toBeNull();
    expect(container.textContent).toContain('Request timed out.');
    expect(container.textContent).not.toContain('Retrying');
  });

  it('renders retry notice followed by recovered content', () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([])}
        streamingEvents={[transientError, retry, { type: 'text_delta', text: 'Recovered fine.' }]}
      />,
    );
    expect(container.textContent).toContain('Retrying (attempt 1)');
    expect(container.textContent).toContain('Recovered fine.');
    expect(container.querySelector('.text-red')).toBeNull();
  });
});
