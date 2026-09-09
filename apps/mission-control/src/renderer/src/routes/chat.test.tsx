import '@testing-library/jest-dom/vitest';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type {
  ConversationMessage,
  MobileWsServerFrame,
  SubagentListEntry,
} from '@dash/mobile-contract';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { type McAgentEvent, unwrapChatIpcResult } from '../../../shared/ipc.js';
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
  kind: 'user',
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
    connectionIssue: null,
  });
  mockApi.chatListConversations.mockResolvedValue({
    items: conversations,
    nextCursor: null,
    authority: 'gateway',
    gatewayOnline: true,
  });
}

function revisionConflict(current: McConversationView): Error {
  try {
    unwrapChatIpcResult({
      ok: false,
      error: {
        message: 'rename failed',
        apiError: {
          code: 'revision_conflict',
          error: 'Conversation revision does not match If-Match',
          retryable: false,
          details: { current },
        },
      },
    });
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected IPC error reconstruction to throw');
}

beforeEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
  mockApi.chatListConversations.mockReset();
  mockApi.chatGetConversation.mockReset();
  mockApi.chatGetMessages.mockReset();
  mockApi.chatCreateConversation.mockReset();
  mockApi.chatSend.mockReset();
  mockApi.chatRenameConversation.mockReset();
  mockApi.chatDeleteConversation.mockReset();
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
    await vi.waitFor(() => {
      expect(useChatStore.getState().selectedConversationRef).toEqual({
        id: gatewayConversation.id,
        origin: 'gateway',
      });
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

  it('shows a reconnect-required issue instead of a generic offline banner', () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    setCanonicalState([{ ...gatewayConversation, offline: true, readOnly: true }], ref);
    useChatStore.setState({
      gatewayOnline: false,
      connectionIssue: {
        conversation: { id: '*', origin: 'gateway' },
        kind: 'repair_required',
        message: 'Gateway authorization failed. Reconnect this gateway to continue.',
        retryable: false,
      },
    });

    render(<Chat />);

    expect(screen.getByText(/gateway authorization failed/i)).toBeInTheDocument();
    expect(
      screen.queryByText('Gateway offline — cached conversations are read-only.'),
    ).not.toBeInTheDocument();
  });

  it('keeps remote Stop and question answers enabled while other mutations stay locked', async () => {
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
      event: { type: 'question', id: 'remote-question', question: 'Ship?', options: ['Yes'] },
    };
    setCanonicalState([running], ref);
    useChatStore.setState({ streamingFrames: { [conversationKey(ref)]: [eventFrame] } });

    render(<Chat />);

    expect(screen.getByText('Active on another device')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Conversation active on another device')).toBeDisabled();
    expect(screen.getByTestId('status-bar-rename')).toBeDisabled();
    expect(screen.getByTestId('status-bar-delete')).toBeDisabled();
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

  /**
   * D3 — the wedge. `sending[key]` is optimistic and only `refreshTerminal`
   * clears it; lose the turn's `done` (which D5 did to every turn that spawned
   * a child) and a later authoritative read puts `activeTurnId` back to
   * `null`. The composer locked on `activeTurnId !== null || isStreaming`
   * while Stop rendered on `activeTurnId` alone, so the two predicates
   * disagreed and left no control at all.
   */
  it('offers Stop for a local turn the server no longer considers active', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    // The gateway's own answer at that moment was `{ status: 'idle',
    // activeTurnId: null }` — see `x1-screens/32.7-wedged-composer-server-idle.png`.
    const idle = { ...gatewayConversation, status: 'idle' as const, activeTurnId: null };
    setCanonicalState([idle], ref);
    useChatStore.setState({ sending: { [conversationKey(ref)]: true } });

    render(<Chat />);

    const stop = screen.getByLabelText('Stop active turn');
    expect(stop).toBeEnabled();
    await userEvent.click(stop);
    expect(useChatStore.getState().sending[conversationKey(ref)]).toBe(false);
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
    mockApi.chatListConversations.mockImplementation(() => new Promise(() => {}));
    mockApi.chatRenameConversation.mockResolvedValue({
      ...gatewayConversation,
      title: 'Renamed conversation',
      revision: 3,
    });
    render(<Chat />);
    await waitFor(() => expect(mockApi.chatListConversations).toHaveBeenCalled());
    await waitFor(() =>
      expect(useChatStore.getState().conversations[0]).toMatchObject({ status: 'idle' }),
    );

    await userEvent.click(screen.getByTestId('status-bar-rename'));
    const input = screen.getByTestId('status-bar-rename-input');
    fireEvent.change(input, { target: { value: 'Renamed conversation' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(mockApi.chatRenameConversation).toHaveBeenCalledWith(
        ref,
        gatewayConversation.revision,
        'Renamed conversation',
      ),
    );

    await userEvent.click(screen.getByTestId('status-bar-delete'));
    await userEvent.click(screen.getByTestId('status-bar-confirm-delete'));
    expect(mockApi.chatDeleteConversation).toHaveBeenCalledWith(ref, 3);
  });

  it('retains the status-bar rename draft on conflict and retries with the new revision', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const current = { ...gatewayConversation, revision: 4, title: 'Concurrent title' };
    const renamed = { ...current, revision: 5, title: 'My pending title' };
    setCanonicalState([gatewayConversation], ref);
    mockApi.chatListConversations.mockImplementation(() => new Promise(() => {}));
    mockApi.chatRenameConversation
      .mockRejectedValueOnce(revisionConflict(current))
      .mockResolvedValueOnce(renamed);
    render(<Chat />);

    await userEvent.click(screen.getByTestId('status-bar-rename'));
    const input = screen.getByTestId('status-bar-rename-input');
    fireEvent.change(input, { target: { value: 'My pending title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockApi.chatRenameConversation).toHaveBeenCalled());
    expect(mockApi.chatRenameConversation).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('status-bar-rename-input')).toHaveValue('My pending title'),
    );
    expect(useChatStore.getState().conversations[0]).toMatchObject(current);
    fireEvent.keyDown(screen.getByTestId('status-bar-rename-input'), { key: 'Enter' });

    await waitFor(() => expect(screen.queryByTestId('status-bar-rename-input')).toBeNull());
    expect(mockApi.chatRenameConversation).toHaveBeenNthCalledWith(
      1,
      ref,
      gatewayConversation.revision,
      'My pending title',
    );
    expect(mockApi.chatRenameConversation).toHaveBeenNthCalledWith(
      2,
      ref,
      current.revision,
      'My pending title',
    );
  });

  it('retains the browser rename draft on conflict for an explicit retry', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const current = { ...gatewayConversation, revision: 4, title: 'Concurrent title' };
    const renamed = { ...current, revision: 5, title: 'Browser draft' };
    setCanonicalState([gatewayConversation], ref);
    mockApi.chatListConversations.mockImplementation(() => new Promise(() => {}));
    mockApi.chatRenameConversation
      .mockRejectedValueOnce(revisionConflict(current))
      .mockResolvedValueOnce(renamed);
    render(<Chat />);

    await userEvent.click(screen.getByLabelText('Browse conversations'));
    await userEvent.click(screen.getByLabelText(`Rename ${gatewayConversation.title}`));
    const input = screen.getByDisplayValue(gatewayConversation.title);
    fireEvent.change(input, { target: { value: 'Browser draft' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByDisplayValue('Browser draft')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByDisplayValue('Browser draft'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByDisplayValue('Browser draft')).toBeNull());
    expect(mockApi.chatRenameConversation).toHaveBeenNthCalledWith(
      2,
      ref,
      current.revision,
      'Browser draft',
    );
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

// --- Sub-agent cards (design §8.1, §8.3) ------------------------------------

describe('MessageBubble sub-agent cards', () => {
  const START = '2026-09-04T00:00:00.000Z';
  const END = '2026-09-04T00:00:45.000Z';
  // Every card below is drawn for the conversation the store has selected, the
  // way the Chat route draws it. A bubble that states a different conversation
  // — or none — draws read-only cards, which is its own test.
  const CARD_KEY = 'gateway:parent-1';

  function assistantMessage(events: Record<string, unknown>[]) {
    return {
      id: 'm1',
      role: 'assistant' as const,
      content: { type: 'assistant' as const, events },
      timestamp: '2026-07-06T00:00:00Z',
    };
  }

  const started = {
    type: 'subagent_started' as const,
    subagentId: 'sub_a',
    name: 'reviewer',
    subagentType: 'code-reviewer',
    description: 'Review the diff',
    prompt: 'Review it',
    model: 'anthropic/claude-opus-4',
    background: false,
    depth: 1,
    startedAt: START,
  };
  const finishedEvent = {
    type: 'subagent_finished' as const,
    subagentId: 'sub_a',
    name: 'reviewer',
    subagentType: 'code-reviewer',
    description: 'Review the diff',
    status: 'done',
    report: 'Two findings, both minor.',
    toolCallCount: 12,
    startedAt: START,
    endedAt: END,
  };

  function entry(over: Record<string, unknown> = {}): SubagentListEntry {
    return {
      id: 'sub_a',
      type: 'code-reviewer',
      description: 'Review the diff',
      status: 'running',
      background: false,
      depth: 1,
      startedAt: START,
      toolCallCount: 12,
      oneShot: false,
      ...over,
    } as SubagentListEntry;
  }

  beforeEach(() => {
    // A card only ever renders inside a selected conversation, and the list
    // re-read is addressed to that conversation.
    useChatStore.setState({
      subagents: [],
      subagentUi: {},
      selectedConversationRef: { id: 'parent-1', origin: 'gateway' },
    });
    mockApi.subagentsList.mockReset();
    mockApi.subagentsList.mockResolvedValue([]);
    mockApi.conversationMessages.mockReset();
    mockApi.conversationMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      throughSeq: 0,
    });
    mockApi.subagentResume.mockReset();
    mockApi.subagentResume.mockResolvedValue({ ok: true, status: 'running', mode: 'queued' });
  });

  it('renders one card with the type, description and "12 tool uses · 45s"', () => {
    render(
      <MessageBubble
        message={assistantMessage([started, finishedEvent])}
        conversationKey={CARD_KEY}
      />,
    );

    const card = screen.getByTestId('subagent-card-sub_a');
    expect(card).toHaveTextContent('code-reviewer');
    expect(card).toHaveTextContent('Review the diff');
    expect(within(card).getByTestId('subagent-card-meta')).toHaveTextContent('12 tool uses · 45s');
  });

  /**
   * D8 ruling 4 — one malformed persisted event must not make a conversation
   * unopenable. MC has no strict decode (`McAgentEvent` mirrors the open
   * `AgentEvent` shape), so the degradation is at RENDER time. Measured, not
   * assumed: it renders NOTHING for the bad event and every sibling survives.
   * Same outcome as web; iOS placeholders it instead, because `.unknown` is
   * the only non-fatal escape a strict decoder has.
   */
  it('drops a malformed sub-agent event, keeping every sibling in the message', () => {
    const { container } = render(
      <MessageBubble
        conversationKey={CARD_KEY}
        message={assistantMessage([
          { type: 'text_delta', text: 'before' },
          // `subagent_finished` with no `subagentId` — the key the fold uses.
          {
            type: 'subagent_finished',
            subagentType: 'Explore',
            description: 'd',
            status: 'done',
            report: 'r',
          },
          { type: 'text_delta', text: 'after' },
        ])}
      />,
    );

    expect(screen.queryByTestId('subagent-card-meta')).toBeNull();
    expect(screen.queryByText('Activity from a newer Dash version')).not.toBeInTheDocument();
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
  });

  // A persisted PRE-D8 message carries the retired mirror. It must draw
  // exactly one card (from the canonical half) and no unknown-activity row.
  it('no longer draws a child as activity from a newer Dash version', () => {
    render(
      <MessageBubble
        conversationKey={CARD_KEY}
        message={assistantMessage([
          {
            type: 'worker_spawned',
            workerId: 'sub_a',
            runId: 'r',
            role: 'reviewer',
            brief: 'b',
            model: 'm',
          },
          { type: 'agent_spawned', name: 'reviewer' },
          started,
        ])}
      />,
    );

    expect(screen.queryByText('Activity from a newer Dash version')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('subagent-card-sub_a')).toHaveLength(1);
  });

  it('renders no elapsed segment for a terminal child with no endedAt', () => {
    render(
      <MessageBubble
        conversationKey={CARD_KEY}
        message={assistantMessage([
          { ...started, startedAt: undefined } as unknown as McAgentEvent,
        ])}
      />,
    );

    const meta = screen.getByTestId('subagent-card-meta');
    expect(meta).toHaveTextContent('0 tool uses');
    expect(meta.textContent).not.toContain('·');
  });

  // The store's `subagents` list belongs to the SELECTED conversation. A card
  // drawn for any other one — `SessionPanel` draws a project session's
  // transcript with the same bubble — must not read it, and must not offer
  // actions whose follow-up read would refresh a different conversation.
  // Same id, different origin: the store models that pair deliberately.
  it('renders fold-only for a card that is not on the selected conversation', () => {
    useChatStore.setState({ subagents: [entry({ status: 'done', oneShot: true })] });

    render(
      <MessageBubble
        message={assistantMessage([{ ...started, background: true }])}
        conversationKey="local:parent-1"
      />,
    );

    const card = screen.getByTestId('subagent-card-sub_a');
    expect(card).toHaveAttribute('data-status', 'running');
    expect(screen.queryByTestId('subagent-card-toggle-sub_a')).not.toBeInTheDocument();
  });

  // Design §8.2: adjacent children render inside one group container with a
  // summary line, a dot strip and a collapse-as-a-unit toggle. The line is
  // `formatClusterSummary`'s, which is byte-identical to web's and to the
  // spec's own example.
  it('draws two adjacent children as one parallel group with the spec summary line', () => {
    render(
      <MessageBubble
        message={assistantMessage([])}
        streamingEvents={[started, { ...started, subagentId: 'sub_b', name: 'planner' }]}
        conversationKey={CARD_KEY}
      />,
    );

    const group = screen.getByTestId('subagent-group');
    expect(group).toHaveTextContent('2 agents · 2 running');
    expect(within(group).getByTestId('subagent-card-sub_a')).toBeInTheDocument();
    expect(within(group).getByTestId('subagent-card-sub_b')).toBeInTheDocument();
  });

  // The group header is a card-level affordance one level up, and it obeys the
  // same rule: it writes `subagentUi`, which belongs to the selected
  // conversation. Off it, the summary line renders and nothing is clickable.
  it('gives a parallel group no toggle when it is not on the selected conversation', () => {
    render(
      <MessageBubble
        message={assistantMessage([])}
        streamingEvents={[started, { ...started, subagentId: 'sub_b', name: 'planner' }]}
        conversationKey="local:parent-1"
      />,
    );

    expect(screen.getByTestId('subagent-group')).toHaveTextContent('2 agents · 2 running');
    expect(screen.queryByTestId('subagent-group-toggle-sub_a')).not.toBeInTheDocument();
  });

  // The header counts what the cards beneath it count. The broad trigger is an
  // ordinary `background: true` fan-out: those children outlive the parent
  // turn, so no event ever moves the fold again and only the list read knows
  // what became of them. Left on the fold, the summary line and the dot strip
  // would contradict the cards under them for the life of the conversation.
  it('counts the resolved statuses in the group summary and dots, as its cards do', () => {
    useChatStore.setState({ subagents: [entry({ status: 'running' })] });

    render(
      <MessageBubble
        message={assistantMessage([
          { ...started, background: true },
          finishedEvent,
          { ...started, subagentId: 'sub_b', name: 'planner', background: true },
        ])}
        conversationKey={CARD_KEY}
      />,
    );

    expect(screen.getByTestId('subagent-card-sub_a')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('subagent-group')).toHaveTextContent('2 agents · 2 running');
    const dot = screen.getByTestId('subagent-group-dot-sub_a');
    expect(dot).toHaveAttribute('title', 'code-reviewer: running');
    expect(dot.className).toContain('bg-accent');
  });

  // Off the selected conversation the fold is the only honest source — the
  // list describes somebody else's children — so the summary line and the dots
  // stay on it, exactly as the cards beneath them do.
  it('leaves the group summary and dots on the fold off the selected conversation', () => {
    useChatStore.setState({ subagents: [entry({ status: 'running' })] });

    render(
      <MessageBubble
        message={assistantMessage([
          { ...started, background: true },
          finishedEvent,
          { ...started, subagentId: 'sub_b', name: 'planner', background: true },
        ])}
        conversationKey="local:parent-1"
      />,
    );

    expect(screen.getByTestId('subagent-card-sub_a')).toHaveAttribute('data-status', 'done');
    expect(screen.getByTestId('subagent-group')).toHaveTextContent('2 agents · 1 running · 1 done');
    expect(screen.getByTestId('subagent-group-dot-sub_a')).toHaveAttribute(
      'title',
      'code-reviewer: done',
    );
  });

  it('collapses a parallel group as a unit', () => {
    render(
      <MessageBubble
        message={assistantMessage([])}
        streamingEvents={[started, { ...started, subagentId: 'sub_b', name: 'planner' }]}
        conversationKey={CARD_KEY}
      />,
    );

    fireEvent.click(screen.getByTestId('subagent-group-toggle-sub_a'));

    expect(screen.queryByTestId('subagent-card-sub_a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subagent-card-sub_b')).not.toBeInTheDocument();
    expect(screen.getByTestId('subagent-group')).toHaveTextContent('2 agents · 2 running');
  });

  it('gives a lone child no group chrome, and splits a group on other content', () => {
    render(
      <MessageBubble
        message={assistantMessage([])}
        streamingEvents={[
          started,
          { type: 'text_delta', text: 'thinking out loud' },
          { ...started, subagentId: 'sub_b', name: 'planner' },
        ]}
        conversationKey={CARD_KEY}
      />,
    );

    expect(screen.queryByTestId('subagent-group')).not.toBeInTheDocument();
    expect(screen.getByTestId('subagent-card-sub_a')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-card-sub_b')).toBeInTheDocument();
  });

  it('reads the server status over its own fold', () => {
    useChatStore.setState({ subagents: [entry({ status: 'running' })] });

    render(
      <MessageBubble
        message={assistantMessage([started, finishedEvent])}
        conversationKey={CARD_KEY}
      />,
    );

    expect(screen.getByTestId('subagent-card-sub_a')).toHaveAttribute('data-status', 'running');
  });

  it('falls back to the fold for a child the list does not carry', () => {
    render(
      <MessageBubble
        message={assistantMessage([started, finishedEvent])}
        conversationKey={CARD_KEY}
      />,
    );

    expect(screen.getByTestId('subagent-card-sub_a')).toHaveAttribute('data-status', 'done');
  });

  // Ruling 2: the fold is still holding a live question because no child event
  // reaches a parent whose turn is over; only the server knows the child was
  // stopped. The one-line detail keeps the question text — it IS the last thing
  // the child said — but the reply affordance must be gone.
  it('offers no reply on a row the server says is finished', () => {
    useChatStore.setState({ subagents: [entry({ status: 'cancelled' })] });
    const waiting = {
      type: 'subagent_progress' as const,
      subagentId: 'sub_a',
      status: 'waiting_input' as const,
      question: 'Which branch?',
      toolCallCount: 1,
      elapsedMs: 10,
    };

    render(
      <MessageBubble
        message={assistantMessage([started, waiting])}
        streamingEvents={[started, waiting]}
        conversationKey={CARD_KEY}
      />,
    );

    expect(screen.getByTestId('subagent-card-sub_a')).toHaveAttribute('data-status', 'cancelled');
    expect(screen.queryByTestId('subagent-reply-input-sub_a')).not.toBeInTheDocument();
  });

  it('fetches the child transcript on first expansion and renders it nested', async () => {
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          id: 'cm1',
          conversationId: 'sub_a',
          turnId: 't1',
          ordinal: 1,
          role: 'assistant',
          status: 'completed',
          content: { type: 'assistant', events: [{ type: 'text_delta', text: 'child says hi' }] },
          createdAt: START,
          updatedAt: START,
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    render(
      <MessageBubble
        message={assistantMessage([started, finishedEvent])}
        conversationKey={CARD_KEY}
      />,
    );
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    await waitFor(() => expect(mockApi.conversationMessages).toHaveBeenCalledWith('sub_a'));
    expect(await screen.findByText('child says hi')).toBeInTheDocument();
    expect(screen.getByText('Two findings, both minor.')).toBeInTheDocument();
  });

  // Ruling 7: both other clients cap nesting at one level, and an expandable
  // grandchild would fetch a new transcript on every expansion, without bound.
  it('renders a grandchild inside an expanded card without a toggle', async () => {
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          id: 'cm1',
          conversationId: 'sub_a',
          turnId: 't1',
          ordinal: 1,
          role: 'assistant',
          status: 'completed',
          content: {
            type: 'assistant',
            events: [{ ...started, subagentId: 'sub_b', depth: 2, description: 'Grandchild work' }],
          },
          createdAt: START,
          updatedAt: START,
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    render(
      <MessageBubble
        message={assistantMessage([started, finishedEvent])}
        conversationKey={CARD_KEY}
      />,
    );
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    expect(await screen.findByTestId('subagent-card-sub_b')).toBeInTheDocument();
    expect(screen.queryByTestId('subagent-card-toggle-sub_b')).not.toBeInTheDocument();
  });

  // A BACKGROUND child parked on a question in a message whose turn is long
  // over — the case the whole panel exists for, and the one where the fold's
  // end-of-stream terminalization is exempted.
  const waitingBackground = [
    { ...started, background: true },
    {
      type: 'subagent_progress' as const,
      subagentId: 'sub_a',
      status: 'waiting_input' as const,
      question: 'Which branch?',
      toolCallCount: 1,
      elapsedMs: 10,
    },
  ];

  // A message the child is still streaming must render as LIVE: the walk's
  // tail-flush draws an unresolved `tool_use_start` as "interrupted" and the
  // fold terminalizes a grandchild to `cancelled` when it is told the stream
  // has ended.
  it('renders a still-streaming child message as live, not as interrupted', async () => {
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          id: 'cm1',
          conversationId: 'sub_a',
          turnId: 't1',
          ordinal: 1,
          role: 'assistant',
          status: 'streaming',
          content: {
            type: 'assistant',
            events: [{ type: 'tool_use_start', id: 'x1', name: 'bash', input: {} }],
          },
          createdAt: START,
          updatedAt: START,
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    render(
      <MessageBubble
        message={assistantMessage([started])}
        streamingEvents={[started]}
        conversationKey={CARD_KEY}
      />,
    );
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    const transcript = await screen.findByTestId('subagent-transcript');
    expect(transcript.textContent).not.toContain('interrupted');
  });

  // The other half of the same claim: with `isStreaming=false` the fold
  // terminalizes a grandchild that has no `subagent_finished` to `cancelled`.
  it('keeps a grandchild of a still-streaming child message running, not cancelled', async () => {
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          id: 'cm1',
          conversationId: 'sub_a',
          turnId: 't1',
          ordinal: 1,
          role: 'assistant',
          status: 'streaming',
          content: {
            type: 'assistant',
            events: [{ ...started, subagentId: 'sub_b', depth: 2, description: 'Grandchild work' }],
          },
          createdAt: START,
          updatedAt: START,
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    render(
      <MessageBubble
        message={assistantMessage([started])}
        streamingEvents={[started]}
        conversationKey={CARD_KEY}
      />,
    );
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    const grandchild = await screen.findByTestId('subagent-card-sub_b');
    expect(grandchild).toHaveAttribute('data-status', 'running');
  });

  it('uses the pause and hourglass glyphs the spec names', () => {
    const { container } = render(
      <MessageBubble
        conversationKey={CARD_KEY}
        message={assistantMessage([
          started,
          { ...finishedEvent, status: 'interrupted', report: '' },
        ])}
      />,
    );
    expect(container.querySelector('.lucide-pause')).not.toBeNull();

    cleanup();
    const second = render(
      <MessageBubble
        conversationKey={CARD_KEY}
        message={assistantMessage([started, { ...finishedEvent, status: 'max_turns', report: '' }])}
      />,
    );
    expect(second.container.querySelector('.lucide-hourglass')).not.toBeNull();
  });

  // §8.1 puts the pending question on the COLLAPSED row precisely so nobody
  // has to expand a card to discover a child is stuck. A read-only card still
  // says so; what it drops is the reply box, which is the action.
  // A card off the selected conversation has NO live source: the list belongs
  // to another conversation, the poll re-reads only that one, and a background
  // child's fold is never moved again once its parent's turn has ended. So it
  // renders nothing live — the clock does not tick and the yellow question,
  // which the fold may have been holding for hours, is not shown as if it were
  // still being asked. It says what it is instead.
  it('draws a read-only card as a snapshot, with no ticking clock and no question', () => {
    render(
      <MessageBubble
        message={assistantMessage(waitingBackground)}
        conversationKey="local:parent-1"
      />,
    );

    const card = screen.getByTestId('subagent-card-sub_a');
    expect(card).toHaveAttribute('data-status', 'waiting');
    expect(within(card).getByTestId('subagent-card-meta').textContent).not.toContain('·');
    expect(card.querySelector('.animate-spin')).toBeNull();
    expect(screen.queryByTestId('subagent-question-sub_a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subagent-reply-input-sub_a')).not.toBeInTheDocument();
    expect(screen.getByTestId('subagent-card-snapshot-sub_a')).toHaveTextContent('snapshot');
  });

  // Frozen, not blank: a run the fold saw finish has a real duration, and a
  // snapshot of it is honest. This is D1/D2's rule — an elapsed segment needs
  // `endedAt`, never `now`.
  it('keeps a finished read-only card its recorded duration', () => {
    render(
      <MessageBubble
        message={assistantMessage([started, finishedEvent])}
        conversationKey="local:parent-1"
      />,
    );

    expect(screen.getByTestId('subagent-card-meta')).toHaveTextContent('12 tool uses · 45s');
    expect(screen.getByTestId('subagent-card-snapshot-sub_a')).toBeInTheDocument();
  });

  it('replies to a waiting child from the card, and re-reads afterwards', async () => {
    useChatStore.setState({ subagents: [entry({ status: 'waiting_input' })] });

    render(
      <MessageBubble message={assistantMessage(waitingBackground)} conversationKey={CARD_KEY} />,
    );

    expect(screen.getByTestId('subagent-question-sub_a')).toHaveTextContent('Which branch?');
    fireEvent.change(screen.getByTestId('subagent-reply-input-sub_a'), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByTestId('subagent-reply-button-sub_a'));

    await waitFor(() =>
      expect(mockApi.subagentResume).toHaveBeenCalledWith('sub_a', 'main', expect.any(String)),
    );
    await waitFor(() => expect(mockApi.subagentsList).toHaveBeenCalled());
  });

  // The reply box appears the instant the FOLD sees the child park, and
  // `subagent_progress` is deliberately not a list trigger — so REST still
  // says `running` for up to 20 s while the user is looking at the question.
  // Deciding "is this an answer?" from REST alone gets that window wrong, and
  // an answer starts no turn, emits no `accepted` and persists no user row:
  // the optimistic row would have nothing to pair with and nothing to
  // supersede it.
  it('adds no optimistic row for an answer the list has not caught up with', async () => {
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, id: 'parent-1', agentId: 'agent-1' }],
      subagents: [entry({ status: 'running' })],
    });

    render(
      <MessageBubble message={assistantMessage(waitingBackground)} conversationKey={CARD_KEY} />,
    );
    // The hold is what turns optimism on at all, so the card must be open.
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));
    await waitFor(() => expect(mockApi.subagentSubscribe).toHaveBeenCalledWith('agent-1', 'sub_a'));

    fireEvent.change(screen.getByTestId('subagent-reply-input-sub_a'), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByTestId('subagent-reply-button-sub_a'));

    await waitFor(() => expect(mockApi.subagentResume).toHaveBeenCalled());
    const rows = useChatStore.getState().subagentUi.sub_a.transcript ?? [];
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(0);
  });

  // …and the complement, so the fix cannot be "never show the row": a steer
  // typed into the BODY composer of a running child does get one, because its
  // `accepted` really is coming.
  it('still shows the row for a steer typed into a running child', async () => {
    useChatStore.setState({
      conversations: [{ ...gatewayConversation, id: 'parent-1', agentId: 'agent-1' }],
      subagents: [entry({ status: 'running' })],
    });

    render(<MessageBubble message={assistantMessage([started])} conversationKey={CARD_KEY} />);
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));
    await waitFor(() => expect(mockApi.subagentSubscribe).toHaveBeenCalledWith('agent-1', 'sub_a'));

    fireEvent.change(screen.getByTestId('subagent-compose-input-sub_a'), {
      target: { value: 'try the other branch' },
    });
    fireEvent.click(screen.getByTestId('subagent-compose-button-sub_a'));

    await waitFor(() => expect(mockApi.subagentResume).toHaveBeenCalled());
    const rows = useChatStore.getState().subagentUi.sub_a.transcript ?? [];
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
  });

  // Ruling 5: a refusal with no render site is a refusal nobody sees. The card
  // is one of the two action sites; the panel is the other.
  it('shows the gateway reason on the card when a reply is refused', async () => {
    useChatStore.setState({ subagents: [entry({ status: 'waiting_input' })] });
    mockApi.subagentResume.mockResolvedValue({
      ok: false,
      reason: 'sub-agent type Explore is one-shot and cannot be resumed',
    });

    render(
      <MessageBubble message={assistantMessage(waitingBackground)} conversationKey={CARD_KEY} />,
    );

    fireEvent.change(screen.getByTestId('subagent-reply-input-sub_a'), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByTestId('subagent-reply-button-sub_a'));

    expect(
      await screen.findByText('sub-agent type Explore is one-shot and cannot be resumed'),
    ).toBeInTheDocument();
    // The sentence the user typed survives the refusal.
    expect(screen.getByTestId('subagent-reply-input-sub_a')).toHaveValue('main');
  });

  // D2 fix round 2 (`10cacdc2`): a one-shot child PARKED ON A QUESTION can be
  // answered. Only a one-shot child that is not waiting refuses.
  it('lets a one-shot child parked on a question be answered', () => {
    useChatStore.setState({ subagents: [entry({ status: 'waiting_input', oneShot: true })] });

    render(
      <MessageBubble message={assistantMessage(waitingBackground)} conversationKey={CARD_KEY} />,
    );
    fireEvent.change(screen.getByTestId('subagent-reply-input-sub_a'), {
      target: { value: 'main' },
    });

    expect(screen.getByTestId('subagent-reply-input-sub_a')).not.toBeDisabled();
    expect(screen.getByTestId('subagent-reply-button-sub_a')).not.toBeDisabled();
  });

  // Ruling 1: subscribe exactly while the card is expanded. The parent's own
  // conversation has to be in the store for the hold to be addressable — a
  // child rides its parent's agent id.
  const parentConversation: McConversationView = {
    ...gatewayConversation,
    id: 'parent-1',
    agentId: 'agent-1',
  };

  it("holds the child's stream while the card is open, and lets it go on collapse", async () => {
    useChatStore.setState({ conversations: [parentConversation] });

    render(<MessageBubble message={assistantMessage([started])} conversationKey={CARD_KEY} />);
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    await waitFor(() => expect(mockApi.subagentSubscribe).toHaveBeenCalledWith('agent-1', 'sub_a'));

    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    await waitFor(() => expect(mockApi.subagentUnsubscribe).toHaveBeenCalledWith('sub_a'));
  });

  // Ruling 7. A grandchild has no toggle, so it cannot be expanded — and it
  // must not take a hold on its own account either.
  it('takes no hold for a card that cannot be opened', async () => {
    useChatStore.setState({ conversations: [parentConversation] });
    mockApi.conversationMessages.mockResolvedValue({
      items: [
        {
          id: 'cm1',
          conversationId: 'sub_a',
          turnId: 't1',
          ordinal: 1,
          role: 'assistant',
          status: 'completed',
          content: {
            type: 'assistant',
            events: [{ ...started, subagentId: 'sub_b', depth: 2, description: 'Grandchild' }],
          },
          createdAt: START,
          updatedAt: START,
        },
      ],
      nextCursor: null,
      throughSeq: 0,
    });

    render(<MessageBubble message={assistantMessage([started])} conversationKey={CARD_KEY} />);
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    expect(await screen.findByTestId('subagent-card-sub_b')).toBeInTheDocument();
    expect(mockApi.subagentSubscribe).not.toHaveBeenCalledWith('agent-1', 'sub_b');
  });

  // The whole point of D7b: an open card grows on its own, with no re-fetch and
  // no action by the user.
  it('grows while it is open, from the child’s own stream', async () => {
    useChatStore.setState({ conversations: [parentConversation] });

    render(<MessageBubble message={assistantMessage([started])} conversationKey={CARD_KEY} />);
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));
    await waitFor(() => expect(mockApi.subagentSubscribe).toHaveBeenCalledWith('agent-1', 'sub_a'));

    await act(async () => {
      await useChatStore.getState().applyFrame({
        type: 'accepted',
        id: 'child-turn-1',
        conversationId: 'sub_a',
        userMessageId: 'child-user-1',
        assistantMessageId: 'child-assistant-1',
        revision: 3,
        seq: 41,
      } as MobileWsServerFrame);
      await useChatStore.getState().applyFrame({
        type: 'event',
        id: 'child-turn-1',
        conversationId: 'sub_a',
        seq: 42,
        event: { type: 'text_delta', text: 'arriving live' },
      } as MobileWsServerFrame);
    });

    expect(await screen.findByText('arriving live')).toBeInTheDocument();
  });

  it('disables the composer of a running one-shot child and says why', async () => {
    useChatStore.setState({ subagents: [entry({ status: 'running', oneShot: true })] });

    render(
      <MessageBubble
        message={assistantMessage([started])}
        streamingEvents={[started]}
        conversationKey={CARD_KEY}
      />,
    );
    fireEvent.click(screen.getByTestId('subagent-card-toggle-sub_a'));

    expect(await screen.findByTestId('subagent-compose-button-sub_a')).toBeDisabled();
    expect(screen.getByTestId('subagent-card-sub_a')).toHaveTextContent('one-shot');
  });
});

/**
 * The Sub-agents panel affordance read `swarm?.enabled === true`, one of the
 * two blocks the gateway consults. The gateway's gate is
 * `subagents?.enabled ?? swarm?.enabled ?? true`, so for the DEFAULT
 * population — an agent with neither block, which has sub-agents on and holds
 * the `agent` tool — the toolbar button was hidden until a child happened to
 * exist. Turning the feature on from the Swarm card, which now writes
 * `subagents.enabled`, would not have brought it back either.
 */
describe('Sub-agents panel affordance', () => {
  const withConfig = (config: Record<string, unknown>) => ({
    ...agent1,
    config: { ...agent1.config, ...config },
  });

  // The affordance is `enabled || this conversation already has children`, so
  // a child left in the store by an earlier test would hide the gate half of
  // it — which is the half these cases are about.
  beforeEach(() => {
    mockApi.subagentsList.mockResolvedValue([]);
    useChatStore.setState({ subagents: [], subagentUi: {} });
  });

  it('is shown for an agent with NEITHER block — sub-agents are on by default', async () => {
    useAgentsStore.setState({ agents: [agent1], loading: false, error: null });
    setCanonicalState([gatewayConversation], { id: gatewayConversation.id, origin: 'gateway' });
    render(<Chat />);
    expect(await screen.findByTestId('swarm-panel-toggle')).toBeInTheDocument();
  });

  it('is shown when only subagents.enabled says so, over a legacy swarm off', async () => {
    useAgentsStore.setState({
      agents: [withConfig({ swarm: { enabled: false }, subagents: { enabled: true } })],
      loading: false,
      error: null,
    });
    setCanonicalState([gatewayConversation], { id: gatewayConversation.id, origin: 'gateway' });
    render(<Chat />);
    expect(await screen.findByTestId('swarm-panel-toggle')).toBeInTheDocument();
  });

  it('is hidden for an agent that really has sub-agents off and no children', async () => {
    // Both directions in ONE test, so the negative cannot be a mistyped
    // selector quietly matching nothing.
    useAgentsStore.setState({ agents: [agent1], loading: false, error: null });
    setCanonicalState([gatewayConversation], { id: gatewayConversation.id, origin: 'gateway' });
    render(<Chat />);
    expect(await screen.findByTestId('swarm-panel-toggle')).toBeInTheDocument();
    cleanup();

    useAgentsStore.setState({
      agents: [withConfig({ subagents: { enabled: false } })],
      loading: false,
      error: null,
    });
    setCanonicalState([gatewayConversation], { id: gatewayConversation.id, origin: 'gateway' });
    render(<Chat />);
    await waitFor(() => expect(screen.queryByTestId('swarm-panel-toggle')).not.toBeInTheDocument());
  });
});
