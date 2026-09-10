import '@testing-library/jest-dom/vitest';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type { ConversationMessage, MobileWsServerFrame } from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessage,
  MobileV2PendingInput,
} from '@dash/mobile-contract-v2';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { type McAgentEvent, unwrapChatIpcResult } from '../../../shared/ipc.js';
import { useAgentsStore } from '../stores/agents.js';
import { applyV2Frame, projectionFromBootstrap } from '../stores/chat-v2-sync.js';
import { type ChatState, conversationKey, useChatStore } from '../stores/chat.js';

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

const { Chat, MessageBubble, V2ConversationTimeline } = await import('./chat.js');

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

function surfaceQuestionMessage(
  conversationId = gatewayConversation.id,
): MobileV2ConversationMessage {
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

function installMainV2(bootstrap: MobileV2ConversationBootstrap): void {
  const ref = { id: bootstrap.conversation.id, origin: 'gateway' as const };
  const key = conversationKey(ref);
  const view: McConversationView = {
    ...gatewayConversation,
    id: bootstrap.conversation.id,
    status: bootstrap.conversation.status,
    activeTurnId: bootstrap.conversation.activeTurnId,
  };
  setCanonicalState([view], ref);
  useChatStore.setState({
    protocolByConversation: { [key]: 'v2' as const },
    v2Projections: { [key]: projectionFromBootstrap(bootstrap) },
    subscribedV2Conversations: { [key]: ref },
    openGenerationByConversation: { [key]: 1 },
    projectionEpochByConversation: { [key]: 1 },
  });
  mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap });
}

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
  useChatStore.setState(originalActions);
  mockApi.chatListConversations.mockReset();
  mockApi.chatGetConversation.mockReset();
  mockApi.chatGetMessages.mockReset();
  mockApi.chatGetInitialState.mockReset();
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
  mockApi.chatGetInitialState.mockResolvedValue({
    protocol: 'v1',
    page: { items: [], nextCursor: null, throughSeq: 0 },
  });
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
    await userEvent.click(screen.getByLabelText('Cancel response'));

    expect(mockApi.chatCancel).toHaveBeenCalledWith(ref, 'local-turn', expect.any(String));
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

describe('v2 main-chat surface integration', () => {
  it('enables active queue input only for a capable gateway conversation', async () => {
    const bootstrap = v2Bootstrap({
      ...gatewayConversation,
      status: 'running',
      activeTurnId: 'run-1',
    });
    installMainV2(bootstrap);
    const capable = render(<Chat />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel response')).toBeInTheDocument();

    capable.unmount();
    await waitFor(() =>
      expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledWith({
        id: gatewayConversation.id,
        origin: 'gateway',
      }),
    );

    const localRef = { id: localConversation.id, origin: 'local' as const };
    const localKey = conversationKey(localRef);
    const runningLocal = {
      ...localConversation,
      status: 'running' as const,
      activeTurnId: 'run-1',
    };
    setCanonicalState([runningLocal], localRef);
    useChatStore.setState({
      protocolByConversation: { [localKey]: 'v1' as const },
      messages: { [localKey]: [] },
    });
    render(<Chat />);

    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cancel response')).toBeInTheDocument();
  });

  it('shares FIFO queue, attachment editing, and the active-response chooser', async () => {
    const first = followUp('first', 1, {
      images: [{ mediaType: 'image/png', data: 'b2xk' }],
    });
    const second = followUp('second', 2);
    installMainV2(
      v2Bootstrap(
        { ...gatewayConversation, status: 'running', activeTurnId: 'run-1' },
        { pendingInputs: [second, first] },
      ),
    );
    const enqueueInput = vi.fn(async () => followUp('acknowledged', 3));
    const editFollowUp = vi.fn(async () => ({ ...first, revision: 2 }));
    useChatStore.setState({ enqueueInput, editFollowUp });
    render(<Chat />);

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
    await userEvent.click(screen.getByRole('button', { name: 'Steer' }));
    await waitFor(() => expect(enqueueInput).toHaveBeenCalledTimes(1));
    expect(enqueueInput).toHaveBeenCalledWith(
      { id: gatewayConversation.id, origin: 'gateway' },
      expect.objectContaining({
        behavior: 'steer',
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
    expect(editFollowUp).toHaveBeenCalledWith(
      { id: gatewayConversation.id, origin: 'gateway' },
      'first',
      1,
      'Follow up 1',
      [expect.objectContaining({ mediaType: 'image/png' })],
    );
  });

  it('keeps the queue visible through Stop and resumes a paused queue explicitly', async () => {
    const item = followUp('first', 1);
    installMainV2(
      v2Bootstrap(
        { ...gatewayConversation, status: 'running', activeTurnId: 'run-1' },
        { pendingInputs: [item], queuePaused: true },
      ),
    );
    const resumeFollowUps = vi.fn(async () => {});
    useChatStore.setState({ resumeFollowUps });
    render(<Chat />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
    expect(screen.getByText('Follow Ups paused')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Cancel response'));
    expect(screen.getByRole('article', { name: 'Follow Up, position 1 of 1' })).toBeInTheDocument();
    expect(mockApi.chatCancel).toHaveBeenCalledWith(
      { id: gatewayConversation.id, origin: 'gateway' },
      'run-1',
      expect.any(String),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resume Follow Ups' }));
    expect(resumeFollowUps).toHaveBeenCalledWith({
      id: gatewayConversation.id,
      origin: 'gateway',
    });
  });

  it('keeps v2 answers tentative through unrelated events and rejection', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const key = conversationKey(ref);
    installMainV2(
      v2Bootstrap(
        { ...gatewayConversation, status: 'running', activeTurnId: 'run-1' },
        { messages: [surfaceQuestionMessage()] },
      ),
    );
    render(<Chat />);
    await waitFor(() =>
      expect(useChatStore.getState().conversationOwnersByConversation[key]).toContain('main-chat'),
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
  ] as const)('renders a %s answer terminal neutrally on main chat', async (_label, terminal) => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const key = conversationKey(ref);
    installMainV2(
      v2Bootstrap(
        { ...gatewayConversation, status: 'running', activeTurnId: 'run-1' },
        { messages: [surfaceQuestionMessage()] },
      ),
    );
    const { container } = render(<Chat />);
    await waitFor(() =>
      expect(useChatStore.getState().conversationOwnersByConversation[key]).toContain('main-chat'),
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
  });

  it('keeps attempted answer context when a terminal arrives before the assistant write', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const key = conversationKey(ref);
    installMainV2(
      v2Bootstrap({ ...gatewayConversation, status: 'running', activeTurnId: 'run-1' }),
    );
    const { container } = render(<Chat />);
    await waitFor(() =>
      expect(useChatStore.getState().conversationOwnersByConversation[key]).toContain('main-chat'),
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

  it('leases the selected socket only while main chat is present and respects overlap', async () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const key = conversationKey(ref);
    const running = {
      ...gatewayConversation,
      status: 'running' as const,
      activeTurnId: 'run-1',
    };
    const bootstrap = v2Bootstrap(running);
    setCanonicalState([running], ref);
    mockApi.chatGetInitialState.mockResolvedValue({ protocol: 'v2', bootstrap });
    const firstMount = render(<Chat />);

    await waitFor(() => expect(mockApi.chatSubscribeV2).toHaveBeenCalledWith(ref, 0));
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual(['main-chat']);
    await act(async () => {
      await useChatStore.getState().openConversation(ref, 'session-panel:overlap');
    });

    firstMount.unmount();
    await waitFor(() =>
      expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual([
        'session-panel:overlap',
      ]),
    );
    expect(mockApi.chatUnsubscribeV2).not.toHaveBeenCalled();

    await act(async () => {
      await useChatStore.getState().closeConversation(ref, 'session-panel:overlap');
    });
    expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledTimes(1);

    const secondMount = render(<Chat />);
    await waitFor(() => expect(mockApi.chatSubscribeV2).toHaveBeenCalledTimes(2));
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toEqual(['main-chat']);
    secondMount.unmount();
  });

  it('ignores a late deep-link lookup after the main-chat lease is released', async () => {
    let settleLookup!: (conversation: McConversationView | null) => void;
    const lookup = new Promise<McConversationView | null>((resolve) => {
      settleLookup = resolve;
    });
    mockUseSearch.mockReturnValue({
      agentId: '',
      conversationId: gatewayConversation.id,
      origin: 'gateway',
    });
    mockApi.chatGetConversation.mockReturnValue(lookup);
    const view = render(<Chat />);
    await waitFor(() => expect(mockApi.chatGetConversation).toHaveBeenCalled());

    view.unmount();
    await act(async () => {
      settleLookup(gatewayConversation);
      await lookup;
    });

    expect(useChatStore.getState().selectedConversationRef).toBeNull();
    expect(mockApi.chatGetInitialState).not.toHaveBeenCalled();
  });

  it('does not let a deferred auto-create reacquire main chat after unmount', async () => {
    const created = deferred<McConversationView>();
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const key = conversationKey(ref);
    mockUseSearch.mockReturnValue({ agentId: agent1.id });
    mockApi.chatCreateConversation.mockReturnValue(created.promise);
    const view = render(<Chat />);
    await waitFor(() => expect(mockApi.chatCreateConversation).toHaveBeenCalledTimes(1));

    view.unmount();
    await waitFor(() => expect(useChatStore.getState().mainChatSurfaceActive).toBe(false));
    act(() => created.resolve(gatewayConversation));
    await waitFor(() =>
      expect(useChatStore.getState().conversations).toContainEqual(gatewayConversation),
    );

    expect(useChatStore.getState().selectedConversationRef).toBeNull();
    expect(useChatStore.getState().conversationOwnersByConversation[key]).toBeUndefined();
    expect(mockApi.chatGetInitialState).not.toHaveBeenCalled();
    expect(mockApi.chatSubscribeV2).not.toHaveBeenCalled();
  });

  it('selects an invalidated fallback while absent and opens it once on remount', async () => {
    const refA = { id: gatewayConversation.id, origin: 'gateway' as const };
    const keyA = conversationKey(refA);
    const refB = { id: 'fallback-conversation', origin: 'gateway' as const };
    const keyB = conversationKey(refB);
    const runningA = {
      ...gatewayConversation,
      status: 'running' as const,
      activeTurnId: 'run-1',
    };
    const runningB: McConversationView = {
      ...runningA,
      id: refB.id,
      title: 'Fallback conversation',
    };
    const bootstrapA = v2Bootstrap(runningA);
    const bootstrapB = v2Bootstrap(runningB);
    setCanonicalState([runningA, runningB], refA);
    useChatStore.setState({ openTabKeys: [keyA, keyB] });
    mockApi.chatGetInitialState.mockImplementation(async (requestedRef) => ({
      protocol: 'v2',
      bootstrap: requestedRef.id === refA.id ? bootstrapA : bootstrapB,
    }));
    const firstMount = render(<Chat />);
    await waitFor(() => expect(mockApi.chatSubscribeV2).toHaveBeenCalledWith(refA, 0));

    firstMount.unmount();
    await waitFor(() => {
      expect(useChatStore.getState().mainChatSurfaceActive).toBe(false);
      expect(useChatStore.getState().conversationOwnersByConversation[keyA]).toBeUndefined();
      expect(mockApi.chatUnsubscribeV2).toHaveBeenCalledWith(refA);
    });
    mockApi.chatGetInitialState.mockClear();
    mockApi.chatSubscribeV2.mockClear();
    mockApi.chatGetConversation.mockResolvedValue(null);

    await act(async () => {
      await useChatStore.getState().invalidateConversation({ type: 'changed', conversation: refA });
    });

    expect(useChatStore.getState().selectedConversationRef).toEqual(refB);
    expect(useChatStore.getState().openTabKeys).toEqual([keyB]);
    expect(useChatStore.getState().conversationOwnersByConversation[keyA]).toBeUndefined();
    expect(useChatStore.getState().conversationOwnersByConversation[keyB]).toBeUndefined();
    expect(mockApi.chatGetInitialState).not.toHaveBeenCalled();
    expect(mockApi.chatSubscribeV2).not.toHaveBeenCalled();

    mockApi.chatListConversations.mockResolvedValue({
      items: [runningB],
      nextCursor: null,
      authority: 'gateway',
      gatewayOnline: true,
    });
    const secondMount = render(<Chat />);
    await waitFor(() => expect(mockApi.chatSubscribeV2).toHaveBeenCalledWith(refB, 0));
    expect(mockApi.chatGetInitialState).toHaveBeenCalledWith(refB);
    expect(mockApi.chatGetInitialState).toHaveBeenCalledTimes(1);
    expect(mockApi.chatSubscribeV2).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().conversationOwnersByConversation[keyA]).toBeUndefined();
    expect(useChatStore.getState().conversationOwnersByConversation[keyB]).toEqual(['main-chat']);
    secondMount.unmount();
  });

  it.each([
    ['ordinary Send', false],
    ['Follow Up', true],
  ] as const)(
    'keeps switched and newer attachment drafts after a late %s acknowledgement',
    async (_label, queued) => {
      const firstRef = { id: gatewayConversation.id, origin: 'gateway' as const };
      const firstKey = conversationKey(firstRef);
      const secondRef = { id: 'second-conversation', origin: 'gateway' as const };
      const secondKey = conversationKey(secondRef);
      const firstView = {
        ...gatewayConversation,
        status: queued ? ('running' as const) : ('idle' as const),
        activeTurnId: queued ? 'run-1' : null,
      };
      const secondView: McConversationView = {
        ...firstView,
        id: secondRef.id,
        title: 'Second conversation',
      };
      setCanonicalState([firstView, secondView], firstRef);

      if (queued) {
        const firstBootstrap = v2Bootstrap(firstView);
        const secondBootstrap = v2Bootstrap(secondView);
        useChatStore.setState({
          protocolByConversation: {
            [firstKey]: 'v2' as const,
            [secondKey]: 'v2' as const,
          },
          v2Projections: {
            [firstKey]: projectionFromBootstrap(firstBootstrap),
            [secondKey]: projectionFromBootstrap(secondBootstrap),
          },
          subscribedV2Conversations: {
            [firstKey]: firstRef,
            [secondKey]: secondRef,
          },
          conversationOwnersByConversation: {
            [firstKey]: ['overlap'],
            [secondKey]: ['overlap'],
          },
          openGenerationByConversation: { [firstKey]: 1, [secondKey]: 1 },
          projectionEpochByConversation: { [firstKey]: 1, [secondKey]: 1 },
        });
        mockApi.chatGetInitialState.mockImplementation(async (requestedRef) => ({
          protocol: 'v2',
          bootstrap: requestedRef.id === firstRef.id ? firstBootstrap : secondBootstrap,
        }));
      } else {
        useChatStore.setState({
          protocolByConversation: {
            [firstKey]: 'v1' as const,
            [secondKey]: 'v1' as const,
          },
          messages: { [firstKey]: [], [secondKey]: [] },
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
      render(<Chat />);

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

      await act(async () => {
        await useChatStore.getState().selectConversation(secondRef);
      });
      await userEvent.type(screen.getByLabelText('Message'), 'draft B');
      await userEvent.upload(
        screen.getByLabelText('Attach images'),
        new File([new Uint8Array([3])], 'second.png', { type: 'image/png' }),
      );
      expect(await screen.findByAltText('Attachment 1')).toBeInTheDocument();

      acknowledge();
      await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('draft B'));
      await act(async () => {
        await useChatStore.getState().selectConversation(firstRef);
      });
      expect(screen.getByLabelText('Message')).toHaveValue('draft A newer');
      expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(newerPreview);
      const action = queued ? enqueueInput : sendMessage;
      expect(action.mock.calls[0]?.[0]).toEqual(firstRef);
    },
  );
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

describe('MessageBubble tool rows (tool-use UX 2026-09-05)', () => {
  function assistantMessage(events: Record<string, unknown>[]) {
    return {
      id: 'm1',
      role: 'assistant' as const,
      content: { type: 'assistant' as const, events },
      timestamp: '2026-07-06T00:00:00Z',
    };
  }

  it('shows what a tool call returned in the collapsed header', () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          { type: 'tool_use_start', id: 't1', name: 'grep', input: { pattern: 'foo' } },
          { type: 'tool_result', id: 't1', name: 'grep', content: 'a.ts:1: foo\nb.ts:2: foo' },
        ])}
      />,
    );
    expect(container.textContent).toContain('2 matches');
  });

  it("shows a failed call's error once, not in the header too", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          { type: 'tool_use_start', id: 't1', name: 'bash', input: { command: 'nope' } },
          {
            type: 'tool_result',
            id: 't1',
            name: 'bash',
            content: 'command not found',
            isError: true,
          },
        ])}
      />,
    );
    // Expanded by default, so the outcome is hidden and only the body shows it.
    const occurrences = (container.textContent ?? '').split('command not found').length - 1;
    expect(occurrences).toBe(1);
  });

  it('shows an MCP tool as its server plus a readable name', () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: 'tool_use_start',
            id: 't1',
            name: 'linear__search_issues',
            input: { query: 'x' },
          },
          { type: 'tool_result', id: 't1', name: 'linear__search_issues', content: 'DASH-1' },
        ])}
      />,
    );
    expect(container.textContent).toContain('Linear');
    expect(container.textContent).toContain('Search Issues');
    expect(container.textContent).not.toContain('linear__search_issues');
  });

  it('opens a failed tool call without a click', () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          { type: 'tool_use_start', id: 't1', name: 'bash', input: { command: 'nope' } },
          {
            type: 'tool_result',
            id: 't1',
            name: 'bash',
            content: 'command not found',
            isError: true,
          },
        ])}
      />,
    );
    expect(container.textContent).toContain('command not found');
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

describe('MessageBubble memory chips', () => {
  function assistantMessage(events: Record<string, unknown>[]) {
    return {
      id: 'm1',
      role: 'assistant' as const,
      content: { type: 'assistant' as const, events },
      timestamp: '2026-07-06T00:00:00Z',
    };
  }

  it('renders a Remembered chip for memory_saved and a Forgot chip for memory_forgotten', () => {
    render(
      <MessageBubble
        message={assistantMessage([
          {
            type: 'memory_saved',
            name: 'user-timezone',
            description: 'Gerry is in Singapore',
            memoryType: 'user',
            action: 'created',
          },
          {
            type: 'memory_saved',
            name: 'user-timezone',
            description: 'Gerry is in Singapore (UTC+8)',
            memoryType: 'user',
            action: 'updated',
          },
          { type: 'memory_forgotten', name: 'old-fact' },
        ])}
      />,
    );

    expect(screen.getByText('Remembered: Gerry is in Singapore')).toBeInTheDocument();
    expect(screen.getByText('Updated memory: Gerry is in Singapore (UTC+8)')).toBeInTheDocument();
    expect(screen.getByText('Forgot: old-fact')).toBeInTheDocument();
    expect(screen.queryByText('Activity from a newer Dash version')).not.toBeInTheDocument();
  });

  it('keeps flushing buffered prose before a memory chip', () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          { type: 'text_delta', text: 'Noted.' },
          {
            type: 'memory_saved',
            name: 'units',
            description: 'Gerry prefers metric units',
            memoryType: 'user',
            action: 'created',
          },
        ])}
      />,
    );

    expect(container.textContent).toContain('Noted.');
    expect(screen.getByText('Remembered: Gerry prefers metric units')).toBeInTheDocument();
  });
});

describe('MessageBubble v2 input and question treatment', () => {
  const steerMessage: MobileV2ConversationMessage = {
    id: '00000000-0000-4000-8000-000000000101',
    conversationId: gatewayConversation.id,
    turnId: 'run-1',
    runId: 'run-1',
    segmentIndex: 1,
    ordinal: 1,
    role: 'user',
    status: 'completed',
    deliveryKind: 'steer',
    deliveryStatus: 'delivered',
    content: { type: 'user', text: 'Focus on reconnects' },
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
  };

  const failedSteer: MobileV2PendingInput = {
    inputId: '00000000-0000-4000-8000-000000000102',
    kind: 'steer',
    targetTurnId: 'run-1',
    text: 'Use the failed path',
    state: 'failed',
    revision: 2,
    enqueueOrder: 1,
    failureCode: 'validation_failed',
    failureMessage: 'The active response changed. Try again.',
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:01Z',
  };

  const pendingSteer: MobileV2PendingInput = {
    inputId: '00000000-0000-4000-8000-000000000103',
    kind: 'steer',
    targetTurnId: 'run-1',
    text: 'Keep the pending path visible',
    state: 'queued',
    revision: 1,
    enqueueOrder: 1,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
  };

  function questionMessage(): ConversationMessage {
    return {
      id: 'assistant-question',
      conversationId: gatewayConversation.id,
      turnId: 'run-1',
      ordinal: 2,
      role: 'assistant',
      status: 'streaming',
      content: {
        type: 'assistant',
        events: [{ type: 'question', id: 'question-1', question: 'Ship?', options: ['Yes', 'No'] }],
      },
      createdAt: '2026-09-06T00:00:01Z',
      updatedAt: '2026-09-06T00:00:01Z',
    };
  }

  it('announces a delivered Steer without treating it as an ordinary user turn', () => {
    render(<MessageBubble message={steerMessage} />);
    expect(screen.getByLabelText('Steered, delivered')).toHaveTextContent('Steered');
    expect(screen.getByText('Focus on reconnects')).toBeInTheDocument();
  });

  it('announces a pending Steer with the normative visible copy', () => {
    render(<MessageBubble input={pendingSteer} />);
    expect(screen.getByLabelText('Steered, pending')).toHaveTextContent('Steered · Pending');
  });

  it('renders a failed Steer as an actionable alert', () => {
    render(<MessageBubble input={failedSteer} />);
    expect(screen.getByLabelText('Steer, not delivered')).toHaveTextContent(
      'Steer · Not delivered',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The active response changed. Try again.');
  });

  it('keeps a v2 answer tentative without a green confirmation check', () => {
    render(
      <MessageBubble
        message={questionMessage()}
        answerAttempts={{
          'question-1': {
            runId: 'run-1',
            questionId: 'question-1',
            answer: 'Yes',
            state: 'pending',
          },
        }}
      />,
    );
    expect(screen.getByText('Answer sent — waiting for response')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  it('restores a rejected v2 answer for item-local retry', async () => {
    const onAnswer = vi.fn();
    render(
      <MessageBubble
        message={questionMessage()}
        onAnswerQuestion={onAnswer}
        answerAttempts={{
          'question-1': {
            runId: 'run-1',
            questionId: 'question-1',
            answer: 'Yes',
            state: 'rejected',
          },
        }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Answer was not delivered: Yes');
    await userEvent.click(screen.getByRole('button', { name: 'Retry answer: Yes' }));
    expect(onAnswer).toHaveBeenCalledWith('question-1', 'Yes');
  });

  it('renders an ended v2 interaction neutrally', () => {
    render(
      <MessageBubble
        message={questionMessage()}
        answerAttempts={{
          'question-1': {
            runId: 'run-1',
            questionId: 'question-1',
            answer: 'Yes',
            state: 'ended',
          },
        }}
      />,
    );
    expect(screen.getByText('Interaction ended')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  it('keeps terminal-before-write events visible without a streaming spinner', () => {
    const initial = projectionFromBootstrap({
      conversation: {
        ...gatewayConversation,
        status: 'running',
        activeTurnId: 'run-1',
        queuePaused: false,
        queueRevision: 0,
        pendingFollowUpCount: 0,
        v2LastSeq: 0,
      },
      messages: [],
      nextCursor: null,
      pendingInputs: [],
      queuePaused: false,
      queueRevision: 0,
      v2ThroughSeq: 0,
    });
    const withEvent = applyV2Frame(initial, {
      type: 'event',
      id: 'run-1',
      conversationId: gatewayConversation.id,
      runId: 'run-1',
      segmentTurnId: 'segment-1',
      v2Seq: 1,
      event: { type: 'text_delta', text: 'Finished before persistence.' },
    }).state;
    const terminal = applyV2Frame(withEvent, {
      type: 'done',
      id: 'run-1',
      conversationId: gatewayConversation.id,
      runId: 'run-1',
      segmentTurnId: 'segment-1',
      v2Seq: 2,
      outcome: 'completed',
    }).state;

    const { container } = render(<V2ConversationTimeline projection={terminal} />);

    expect(screen.getByText('Finished before persistence.')).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });
});
