import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConversationRef, McConversationView } from '@dash/mc';
import type {
  ConversationMessage,
  MobileWsServerFrame,
  SubagentListEntry,
} from '@dash/mobile-contract';
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

type ChatOrderExpected = {
  kind: 'text' | 'thinking' | 'tool' | 'question';
  label?: string;
  text?: string;
};

type ChatOrderFixture = {
  version: number;
  cases: Array<{
    name: string;
    events: Record<string, unknown>[];
    expected: ChatOrderExpected[];
  }>;
};

const chatOrderFixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../../../scripts/fixtures/chat-event-order.json'),
    'utf8',
  ),
) as ChatOrderFixture;

function orderedFixtureElements(expected: ChatOrderExpected[]): HTMLElement[] {
  return expected.map((entry) => {
    if (entry.kind === 'tool') {
      return screen.getByRole('button', { name: new RegExp(entry.label ?? '') });
    }
    if (entry.kind === 'thinking') {
      return screen.getByRole('button', { name: 'Show thinking' });
    }
    if (entry.kind === 'question') {
      return screen.getByText((_, element) =>
        Boolean(element?.tagName === 'P' && element.textContent?.includes(entry.text ?? '')),
      );
    }
    return screen.getByText(entry.text ?? '');
  });
}

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

    const stop = screen.getByLabelText('Cancel response');
    expect(stop).toBeEnabled();
    await userEvent.click(stop);
    expect(useChatStore.getState().sending[conversationKey(ref)]).toBe(false);
  });

  /**
   * D6 — the notification prompt rendered raw.
   *
   * A background child's completion wakes the conversation with a
   * server-initiated turn whose user-side row is the block
   * `packages/swarm/src/notifications.ts` composes. MC drew that block as a
   * full user bubble, `[SYSTEM NOTIFICATION - NOT USER INPUT]` and all
   * (`x1-screens/32.1-cards-and-meta.png`). Design §8.5 says a row.
   */
  it('summarizes a notification turn instead of drawing its raw prompt', () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const raw =
      '[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n' +
      '<task-notification>\n<task-id>sub_01M21PVS</task-id>\n' +
      '<agent-name>writer</agent-name>\n<status>done</status>\n' +
      '<summary>Agent "reply with WRITTEN" finished</summary>\n' +
      '<result>\nWRITTEN\n</result>\n</task-notification>';
    setCanonicalState([gatewayConversation], ref);
    useChatStore.setState({
      messages: {
        [conversationKey(ref)]: [
          {
            id: 'notif-user',
            role: 'user',
            origin: 'notification',
            status: 'complete',
            seq: 12,
            createdAt: '2026-09-09T00:00:00.000Z',
            content: { type: 'user', text: raw },
          } as unknown as ConversationMessage,
          {
            id: 'parent-user',
            role: 'user',
            origin: 'parent',
            status: 'complete',
            seq: 13,
            createdAt: '2026-09-09T00:00:01.000Z',
            content: { type: 'user', text: 'reply with exactly the word WRITTEN' },
          } as unknown as ConversationMessage,
        ],
      },
    });

    render(<Chat />);

    expect(screen.getByTestId('notification-row')).toHaveTextContent(
      'Agent "reply with WRITTEN" finished',
    );
    expect(screen.queryByText(/SYSTEM NOTIFICATION - NOT USER INPUT/)).toBeNull();
    // §8.5's other row: `origin: 'parent'` keeps its TEXT, because that text is
    // the instruction the child is working from — it must not collapse to the
    // notification label, and it must not be a user bubble either.
    const orchestrator = screen.getByTestId('orchestrator-row');
    expect(orchestrator).toHaveTextContent('from orchestrator');
    expect(orchestrator).toHaveTextContent('reply with exactly the word WRITTEN');
  });

  /**
   * D2 — a background child drew a SECOND card. On replay of one conversation
   * with five children, `subagent-card-toggle-*` returned TEN elements
   * (`x1-screens/32.8-replay-duplicate-cards.png`). The two copies also
   * disagreed, one reading `0 tool uses` and the other `1 tool use · 3s`.
   *
   * Driven by `subagent-notification-frames.jsonl`: one real conversation, an
   * assistant turn that spawns a background `writer` and the server-initiated
   * notification turn its completion wakes.
   */
  it('draws one card for a child the notification turn reports again', () => {
    const ref = { id: gatewayConversation.id, origin: 'gateway' as const };
    const frames = readFileSync(
      resolve(
        __dirname,
        '../../../../../../contracts/mobile/v1/fixtures/subagent-notification-frames.jsonl',
      ),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string; event?: McAgentEvent });
    const byTurn = new Map<string, McAgentEvent[]>();
    for (const frame of frames) {
      if (frame.type !== 'event' || !frame.event) continue;
      byTurn.set(frame.id, [...(byTurn.get(frame.id) ?? []), frame.event]);
    }
    const turns = [...byTurn.entries()];
    expect(turns).toHaveLength(2);

    setCanonicalState([gatewayConversation], ref);
    useChatStore.setState({
      messages: {
        [conversationKey(ref)]: turns.map(
          ([turnId, events], index) =>
            ({
              id: turnId,
              role: 'assistant',
              status: 'complete',
              seq: index + 1,
              createdAt: `2026-09-09T00:00:0${index}.000Z`,
              content: { type: 'assistant', events },
            }) as unknown as ConversationMessage,
        ),
      },
    });

    render(<Chat />);

    const started = turns[0][1].find((e) => e.type === 'subagent_started') as
      | { subagentId: string }
      | undefined;
    expect(started).toBeDefined();
    expect(screen.getAllByTestId(`subagent-card-toggle-${started?.subagentId}`)).toHaveLength(1);
  });

  it('draws one v2 card when a notification turn reports the same child again', () => {
    const frames = readFileSync(
      resolve(
        __dirname,
        '../../../../../../contracts/mobile/v1/fixtures/subagent-notification-frames.jsonl',
      ),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string; event?: McAgentEvent });
    const byTurn = new Map<string, McAgentEvent[]>();
    for (const frame of frames) {
      if (frame.type !== 'event' || !frame.event) continue;
      byTurn.set(frame.id, [...(byTurn.get(frame.id) ?? []), frame.event]);
    }
    const turns = [...byTurn.entries()];
    const messages = turns.map(
      ([turnId, events], index): MobileV2ConversationMessage => ({
        id: `v2-assistant-${index}`,
        conversationId: gatewayConversation.id,
        turnId: `${turnId}:segment`,
        runId: turnId,
        segmentIndex: 0,
        ordinal: index * 2 + 1,
        role: 'assistant',
        status: 'completed',
        deliveryKind: 'normal',
        content: { type: 'assistant', events },
        createdAt: `2026-09-09T00:00:0${index}.000Z`,
        updatedAt: `2026-09-09T00:00:0${index}.000Z`,
      }),
    );
    messages.splice(1, 0, {
      id: 'v2-notification-prompt',
      conversationId: gatewayConversation.id,
      turnId: 'notification-run:prompt',
      runId: 'notification-run',
      segmentIndex: 0,
      ordinal: 2,
      role: 'user',
      status: 'completed',
      deliveryKind: 'normal',
      origin: 'notification',
      content: {
        type: 'user',
        text: '<task-notification><task-id>sub_01M21PVS839FQA3STD22Z2BNKM</task-id></task-notification>',
      },
      createdAt: '2026-09-09T00:00:01.000Z',
      updatedAt: '2026-09-09T00:00:01.000Z',
    });
    installMainV2(
      v2Bootstrap(gatewayConversation, {
        activeTurnId: null,
        messages,
      }),
    );

    render(<Chat />);

    expect(
      screen.getAllByTestId('subagent-card-toggle-sub_01M21PVS839FQA3STD22Z2BNKM'),
    ).toHaveLength(1);
    expect(screen.getByTestId('notification-row')).toBeInTheDocument();
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

  it.each(chatOrderFixture.cases)(
    'matches shared assistant event order: $name',
    ({ events, expected }) => {
      render(<MessageBubble message={assistantMessage(events)} />);
      const elements = orderedFixtureElements(expected);
      for (let index = 1; index < elements.length; index++) {
        expect(
          elements[index - 1].compareDocumentPosition(elements[index]) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    },
  );

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

describe('MessageBubble notice chips', () => {
  function noticeMessage(kind: 'skill_learned' | 'memory_saved', text: string) {
    return {
      id: 'n1',
      role: 'assistant' as const,
      content: { type: 'notice' as const, kind, text },
      timestamp: '2026-09-06T00:00:00Z',
    };
  }

  it('renders a learned skill as a chip', () => {
    render(<MessageBubble message={noticeMessage('skill_learned', 'Learned: write-files')} />);

    const chip = screen.getByTestId('notice-chip');
    expect(chip).toHaveTextContent('Learned: write-files');
    expect(chip).toHaveAttribute('data-notice-kind', 'skill_learned');
  });

  it('renders a swept memory as a chip', () => {
    render(<MessageBubble message={noticeMessage('memory_saved', 'Remembered: prefers printf')} />);

    const chip = screen.getByTestId('notice-chip');
    expect(chip).toHaveTextContent('Remembered: prefers printf');
    expect(chip).toHaveAttribute('data-notice-kind', 'memory_saved');
  });

  it('does not render the assistant event pipeline for a notice', () => {
    // A notice carries no events; rendering it through renderEvents would throw
    // or produce an empty assistant bubble instead of a chip.
    const { container } = render(
      <MessageBubble message={noticeMessage('skill_learned', 'Learned: x')} />,
    );
    expect(container.querySelector('[data-testid="notice-chip"]')).not.toBeNull();
    expect(container.textContent).not.toContain('interrupted');
  });
});
