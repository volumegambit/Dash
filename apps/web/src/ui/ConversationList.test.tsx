import type { ConversationSummary, MobileAgent } from '@dash/mobile-contract';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatSocket, FrameHandler } from '../api/chat-socket.js';
import type { MobileRestClient } from '../api/rest.js';
import { createWebAppStore } from '../state/store.js';
import {
  ConversationList,
  NEW_CONVERSATION_LABEL,
  NEW_CONVERSATION_TESTID,
  NO_AGENTS_COPY,
  NO_CONVERSATIONS_COPY,
} from './ConversationList.js';
import { WebAppStoreContext } from './Shell.js';

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'conv-1',
    agentId: 'agent-01',
    agentName: 'Mobile Helper',
    title: 'Mobile launch check',
    revision: 1,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: 'Ready from the gateway.',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function agent(overrides: Partial<MobileAgent> = {}): MobileAgent {
  return {
    id: 'agent-1',
    name: 'Mobile Helper',
    config: { name: 'Mobile Helper', model: 'anthropic/claude-sonnet', systemPrompt: 'Help.' },
    status: 'active',
    registeredAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

/** A `connect()` that resolves immediately — these tests exercise the
 * "New conversation" flow (which opens the created conversation under the
 * hood) but aren't testing socket choreography, unlike ChatView's/the
 * store's own scripted-socket tests. */
function fakeSocket(): ChatSocket {
  return {
    connect: () => Promise.resolve(),
    send: () => {},
    close: () => {},
  } as unknown as ChatSocket;
}

function buildStore(
  conversations: ConversationSummary[],
  opts: {
    agents?: MobileAgent[];
    listAgentsImpl?: () => Promise<MobileAgent[]>;
    createConversationImpl?: (req: unknown) => Promise<ConversationSummary>;
  } = {},
) {
  const rest = {
    listConversations: vi.fn(async () => ({ items: conversations, nextCursor: null })),
    getMessages: vi.fn(async () => ({ items: [], nextCursor: null, throughSeq: 0 })),
    listAgents: vi.fn(opts.listAgentsImpl ?? (async () => opts.agents ?? [])),
    createConversation: vi.fn(
      opts.createConversationImpl ?? (async () => summary({ id: 'new-conv' })),
    ),
  } as unknown as MobileRestClient;
  const factory = vi.fn((_onFrame: FrameHandler, _onClose: (reason: 'error' | 'closed') => void) =>
    fakeSocket(),
  );
  return {
    store: createWebAppStore({ rest, socketFactory: factory }),
    listConversations: rest.listConversations,
    listAgents: rest.listAgents,
    createConversation: rest.createConversation,
  };
}

describe('ConversationList', () => {
  it('loads and renders conversations from the store on mount', async () => {
    const { store, listConversations } = buildStore([
      summary(),
      summary({ id: 'conv-2', title: 'Second' }),
    ]);

    render(
      <WebAppStoreContext.Provider value={store}>
        <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
      </WebAppStoreContext.Provider>,
    );

    await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Mobile launch check')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
    expect(screen.getAllByText('Ready from the gateway.')).toHaveLength(2);
  });

  it('shows the empty-state copy when there are no conversations', async () => {
    const { store } = buildStore([]);

    render(
      <WebAppStoreContext.Provider value={store}>
        <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
      </WebAppStoreContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText(NO_CONVERSATIONS_COPY)).toBeTruthy());
  });

  it("suppresses the empty-state copy when connection is 'offline' or 'unauthorized' (banner owns the screen)", async () => {
    for (const connection of ['offline', 'unauthorized'] as const) {
      const { store } = buildStore([]);
      act(() => {
        store.setState({ connection });
      });

      const { unmount } = render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );

      await waitFor(() => expect(screen.queryByText(NO_CONVERSATIONS_COPY)).toBeNull());
      unmount();
    }
  });

  it('calls onSelect with the conversation id when a row is clicked', async () => {
    const { store } = buildStore([summary()]);
    const onSelect = vi.fn();

    render(
      <WebAppStoreContext.Provider value={store}>
        <ConversationList selectedConversationId={null} onSelect={onSelect} />
      </WebAppStoreContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());
    fireEvent.click(screen.getByText('Mobile launch check'));
    expect(onSelect).toHaveBeenCalledWith('conv-1');
  });

  it('marks the selected conversation as current', async () => {
    const { store } = buildStore([summary(), summary({ id: 'conv-2', title: 'Second' })]);

    render(
      <WebAppStoreContext.Provider value={store}>
        <ConversationList selectedConversationId="conv-2" onSelect={vi.fn()} />
      </WebAppStoreContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText('Second')).toBeTruthy());
    const selectedButton = screen.getByText('Second').closest('button') as HTMLButtonElement;
    const unselectedButton = screen
      .getByText('Mobile launch check')
      .closest('button') as HTMLButtonElement;
    expect(selectedButton.getAttribute('aria-current')).toBe('true');
    expect(unselectedButton.getAttribute('aria-current')).toBeNull();
  });

  describe('New conversation', () => {
    it('renders the New conversation button', async () => {
      const { store } = buildStore([]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );

      const button = await screen.findByTestId(NEW_CONVERSATION_TESTID);
      expect(button.textContent).toBe(NEW_CONVERSATION_LABEL);
    });

    it('with exactly one agent, skips the picker and starts the conversation immediately', async () => {
      const onlyAgent = agent({ id: 'agent-only', name: 'Solo Agent' });
      const created = summary({ id: 'new-conv-1', agentId: 'agent-only' });
      const { store, listAgents, createConversation } = buildStore([], {
        agents: [onlyAgent],
        createConversationImpl: async () => created,
      });
      const onSelect = vi.fn();

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={onSelect} />
        </WebAppStoreContext.Provider>,
      );

      fireEvent.click(await screen.findByTestId(NEW_CONVERSATION_TESTID));

      await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(createConversation).toHaveBeenCalledTimes(1));
      expect(createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-only' }),
      );
      // No picker ever shown for a single agent.
      expect(screen.queryByText('Solo Agent')).toBeNull();
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith('new-conv-1'));
    });

    it('with multiple agents, shows a picker and starts the conversation with the chosen agent', async () => {
      const first = agent({ id: 'agent-a', name: 'Agent A' });
      const second = agent({ id: 'agent-b', name: 'Agent B' });
      const created = summary({ id: 'new-conv-2', agentId: 'agent-b' });
      const { store, createConversation } = buildStore([], {
        agents: [first, second],
        createConversationImpl: async () => created,
      });
      const onSelect = vi.fn();

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={onSelect} />
        </WebAppStoreContext.Provider>,
      );

      fireEvent.click(await screen.findByTestId(NEW_CONVERSATION_TESTID));

      const secondChoice = await screen.findByText('Agent B');
      fireEvent.click(secondChoice);

      await waitFor(() => expect(createConversation).toHaveBeenCalledTimes(1));
      expect(createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-b' }),
      );
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith('new-conv-2'));
    });

    it('surfaces a listAgents() REST failure inline instead of doing nothing', async () => {
      const { store } = buildStore([], {
        listAgentsImpl: async () => {
          throw new Error('agents endpoint is down');
        },
      });

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );

      fireEvent.click(await screen.findByTestId(NEW_CONVERSATION_TESTID));

      await waitFor(() => expect(screen.getByText('agents endpoint is down')).toBeTruthy());
    });

    it('surfaces a startConversation() REST failure inline instead of doing nothing', async () => {
      const onlyAgent = agent({ id: 'agent-only', name: 'Solo Agent' });
      const { store } = buildStore([], {
        agents: [onlyAgent],
        createConversationImpl: async () => {
          throw new Error('create failed');
        },
      });
      const onSelect = vi.fn();

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={onSelect} />
        </WebAppStoreContext.Provider>,
      );

      fireEvent.click(await screen.findByTestId(NEW_CONVERSATION_TESTID));

      await waitFor(() => expect(screen.getByText('create failed')).toBeTruthy());
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('shows a distinct message when the account has no agents at all', async () => {
      const { store } = buildStore([], { agents: [] });

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );

      fireEvent.click(await screen.findByTestId(NEW_CONVERSATION_TESTID));

      await waitFor(() => expect(screen.getByText(NO_AGENTS_COPY)).toBeTruthy());
    });
  });
});
