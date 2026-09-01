import type { ConversationSummary, MobileAgent } from '@dash/mobile-contract';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatSocket, FrameHandler } from '../api/chat-socket.js';
import type { MobileRestClient } from '../api/rest.js';
import { createWebAppStore } from '../state/store.js';
import {
  CONVERSATION_SKELETON_TESTID,
  ConversationList,
  DELETE_ACTION_LABEL,
  DELETE_CONFIRM_COPY,
  NEW_CONVERSATION_LABEL,
  NEW_CONVERSATION_TESTID,
  NO_AGENTS_COPY,
  NO_CONVERSATIONS_COPY,
  NO_SEARCH_RESULTS_COPY,
  RENAME_ACTION_LABEL,
  SEARCH_INPUT_LABEL,
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
    listConversationsImpl?: () => Promise<{ items: ConversationSummary[]; nextCursor: null }>;
    listAgentsImpl?: () => Promise<MobileAgent[]>;
    createConversationImpl?: (req: unknown) => Promise<ConversationSummary>;
    patchConversationImpl?: (
      conversationId: string,
      patch: unknown,
      revision: number,
    ) => Promise<ConversationSummary>;
    deleteConversationImpl?: (
      conversationId: string,
      revision: number,
    ) => Promise<ConversationSummary>;
  } = {},
) {
  const rest = {
    listConversations: vi.fn(
      opts.listConversationsImpl ?? (async () => ({ items: conversations, nextCursor: null })),
    ),
    getMessages: vi.fn(async () => ({ items: [], nextCursor: null, throughSeq: 0 })),
    listAgents: vi.fn(opts.listAgentsImpl ?? (async () => opts.agents ?? [])),
    createConversation: vi.fn(
      opts.createConversationImpl ?? (async () => summary({ id: 'new-conv' })),
    ),
    patchConversation: vi.fn(
      opts.patchConversationImpl ??
        (async (conversationId: string, patch: unknown, revision: number) =>
          summary({ id: conversationId, ...(patch as object), revision: revision + 1 })),
    ),
    deleteConversation: vi.fn(
      opts.deleteConversationImpl ??
        (async (conversationId: string, revision: number) =>
          summary({ id: conversationId, status: 'deleted', revision: revision + 1 })),
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
    patchConversation: rest.patchConversation,
    deleteConversation: rest.deleteConversation,
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

  describe('loading skeleton (chat-ux Phase 3 Task 4, audit #13 remainder)', () => {
    /** A `listConversations` promise the test controls the resolution of,
     * so the loading window is observable rather than racing real
     * microtask timing. */
    function deferredList() {
      let resolve!: (page: { items: ConversationSummary[]; nextCursor: null }) => void;
      const promise = new Promise<{ items: ConversationSummary[]; nextCursor: null }>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('shows skeleton rows while the initial load is in flight, then swaps to the real list', async () => {
      const { promise, resolve } = deferredList();
      const { store } = buildStore([], { listConversationsImpl: () => promise });

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );

      expect(screen.getByTestId(CONVERSATION_SKELETON_TESTID)).toBeTruthy();
      expect(screen.queryByText(NO_CONVERSATIONS_COPY)).toBeNull();
      expect(screen.queryByText('Mobile launch check')).toBeNull();

      await act(async () => {
        resolve({ items: [summary()], nextCursor: null });
        await promise;
      });

      await waitFor(() => expect(screen.queryByTestId(CONVERSATION_SKELETON_TESTID)).toBeNull());
      expect(screen.getByText('Mobile launch check')).toBeTruthy();
    });

    it('swaps the skeleton for the empty-state copy when the load resolves to zero conversations', async () => {
      const { promise, resolve } = deferredList();
      const { store } = buildStore([], { listConversationsImpl: () => promise });

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );

      expect(screen.getByTestId(CONVERSATION_SKELETON_TESTID)).toBeTruthy();

      await act(async () => {
        resolve({ items: [], nextCursor: null });
        await promise;
      });

      await waitFor(() => expect(screen.getByText(NO_CONVERSATIONS_COPY)).toBeTruthy());
      expect(screen.queryByTestId(CONVERSATION_SKELETON_TESTID)).toBeNull();
    });

    it("suppresses the skeleton (like the empty-state copy) when connection is 'offline' or 'unauthorized'", async () => {
      for (const connection of ['offline', 'unauthorized'] as const) {
        const { promise } = deferredList(); // never resolved — isLoading stays true throughout
        const { store } = buildStore([], { listConversationsImpl: () => promise });
        act(() => {
          store.setState({ connection });
        });

        const { unmount } = render(
          <WebAppStoreContext.Provider value={store}>
            <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
          </WebAppStoreContext.Provider>,
        );

        expect(screen.queryByTestId(CONVERSATION_SKELETON_TESTID)).toBeNull();
        unmount();
      }
    });
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

    it('final-review fix I1: three rapid invocations via the imperative ref (mirrors Cmd/Ctrl+Shift+O key-repeat, which bypasses the disabled button) start exactly one conversation', async () => {
      const onlyAgent = agent({ id: 'agent-only', name: 'Solo Agent' });
      const created = summary({ id: 'new-conv-1', agentId: 'agent-only' });
      const { store, listAgents, createConversation } = buildStore([], {
        agents: [onlyAgent],
        createConversationImpl: async () => created,
      });
      const onSelect = vi.fn();
      const newConversationRef = { current: null as (() => void) | null };

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList
            selectedConversationId={null}
            onSelect={onSelect}
            newConversationRef={newConversationRef}
          />
        </WebAppStoreContext.Provider>,
      );

      await waitFor(() => expect(newConversationRef.current).toBeTruthy());

      // All three fire synchronously, in the same tick — before
      // `listAgents()`'s `await` ever yields back to the guard's `finally`.
      // A guard that were armed only via `setBusy(true)` (a state update,
      // not committed until React's next render) would let all three
      // through; the ref-based guard must not.
      act(() => {
        newConversationRef.current?.();
        newConversationRef.current?.();
        newConversationRef.current?.();
      });

      await waitFor(() => expect(createConversation).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
      expect(listAgents).toHaveBeenCalledTimes(1);
    });
  });

  describe('search (chat-ux Phase 3 Task 1, audit #8)', () => {
    it('filters by title, case-insensitively, without calling the store again', async () => {
      const { store, listConversations } = buildStore([
        summary({ id: 'conv-1', title: 'Mobile launch check', lastMessagePreview: 'Ready.' }),
        summary({ id: 'conv-2', title: 'Trip to Lisbon', lastMessagePreview: 'Book flights.' }),
      ]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Trip to Lisbon')).toBeTruthy());

      fireEvent.change(screen.getByLabelText(SEARCH_INPUT_LABEL), {
        target: { value: 'LISBON' },
      });

      expect(screen.queryByText('Mobile launch check')).toBeNull();
      expect(screen.getByText('Trip to Lisbon')).toBeTruthy();
      // Local filtering only — never re-fetches from the store/REST.
      expect(listConversations).toHaveBeenCalledTimes(1);
    });

    it('filters by lastMessagePreview, case-insensitively', async () => {
      const { store } = buildStore([
        summary({ id: 'conv-1', title: 'Mobile launch check', lastMessagePreview: 'Ready.' }),
        summary({ id: 'conv-2', title: 'Trip to Lisbon', lastMessagePreview: 'Book flights.' }),
      ]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.change(screen.getByLabelText(SEARCH_INPUT_LABEL), {
        target: { value: 'flights' },
      });

      expect(screen.queryByText('Mobile launch check')).toBeNull();
      expect(screen.getByText('Trip to Lisbon')).toBeTruthy();
    });

    it('shows a no-results message when the search matches nothing', async () => {
      const { store } = buildStore([summary({ title: 'Mobile launch check' })]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.change(screen.getByLabelText(SEARCH_INPUT_LABEL), {
        target: { value: 'nonexistent' },
      });

      expect(screen.queryByText('Mobile launch check')).toBeNull();
      expect(screen.getByText(NO_SEARCH_RESULTS_COPY)).toBeTruthy();
    });
  });

  describe('rename (chat-ux Phase 3 Task 1, audit #8)', () => {
    it('reveals an inline text input on the rename affordance, pre-filled with the current title', async () => {
      const { store } = buildStore([summary({ title: 'Mobile launch check' })]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.click(screen.getByLabelText(RENAME_ACTION_LABEL));

      const input = screen.getByDisplayValue('Mobile launch check') as HTMLInputElement;
      expect(input).toBeTruthy();
    });

    it('Enter commits the rename via the store', async () => {
      const { store, patchConversation } = buildStore([
        summary({ id: 'conv-1', title: 'Mobile launch check', revision: 1 }),
      ]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.click(screen.getByLabelText(RENAME_ACTION_LABEL));
      const input = screen.getByDisplayValue('Mobile launch check');
      fireEvent.change(input, { target: { value: 'Renamed thread' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() =>
        expect(patchConversation).toHaveBeenCalledWith('conv-1', { title: 'Renamed thread' }, 1),
      );
      await waitFor(() => expect(screen.getByText('Renamed thread')).toBeTruthy());
    });

    it('Escape cancels without committing, reverting to the original title', async () => {
      const { store, patchConversation } = buildStore([
        summary({ id: 'conv-1', title: 'Mobile launch check', revision: 1 }),
      ]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.click(screen.getByLabelText(RENAME_ACTION_LABEL));
      const input = screen.getByDisplayValue('Mobile launch check');
      fireEvent.change(input, { target: { value: 'Discarded edit' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(patchConversation).not.toHaveBeenCalled();
      expect(screen.getByText('Mobile launch check')).toBeTruthy();
      expect(screen.queryByText('Discarded edit')).toBeNull();
    });
  });

  describe('delete (chat-ux Phase 3 Task 1, audit #8)', () => {
    it('clicking the delete affordance shows an inline confirm with the exact copy, not window.confirm', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      const { store } = buildStore([summary({ title: 'Mobile launch check' })]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));

      expect(screen.getByText(DELETE_CONFIRM_COPY)).toBeTruthy();
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('Cancel dismisses the confirm without deleting', async () => {
      const { store, deleteConversation } = buildStore([summary({ title: 'Mobile launch check' })]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));
      fireEvent.click(screen.getByText('Cancel'));

      expect(screen.queryByText(DELETE_CONFIRM_COPY)).toBeNull();
      expect(deleteConversation).not.toHaveBeenCalled();
      expect(screen.getByText('Mobile launch check')).toBeTruthy();
    });

    it('confirming Delete calls the store and removes the row', async () => {
      const { store, deleteConversation } = buildStore([
        summary({ id: 'conv-1', title: 'Mobile launch check', revision: 1 }),
      ]);

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('conv-1', 1));
      await waitFor(() => expect(screen.queryByText('Mobile launch check')).toBeNull());
    });

    it('calls onConversationDeleted with the deleted id once the delete succeeds', async () => {
      const { store } = buildStore([summary({ id: 'conv-1', title: 'Mobile launch check' })]);
      const onConversationDeleted = vi.fn();

      render(
        <WebAppStoreContext.Provider value={store}>
          <ConversationList
            selectedConversationId="conv-1"
            onSelect={vi.fn()}
            onConversationDeleted={onConversationDeleted}
          />
        </WebAppStoreContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

      fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(onConversationDeleted).toHaveBeenCalledWith('conv-1'));
    });

    describe('accessibility and focus management (final-review fix I4)', () => {
      it('the confirm is an announced alertdialog naming the conversation', async () => {
        const { store } = buildStore([summary({ id: 'conv-1', title: 'Mobile launch check' })]);

        render(
          <WebAppStoreContext.Provider value={store}>
            <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
          </WebAppStoreContext.Provider>,
        );
        await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

        fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));

        const dialog = screen.getByRole('alertdialog');
        expect(dialog.getAttribute('aria-label')).toBe('Delete "Mobile launch check"?');
      });

      it('focus moves to the Cancel button when the confirm opens', async () => {
        const { store } = buildStore([summary({ id: 'conv-1', title: 'Mobile launch check' })]);

        render(
          <WebAppStoreContext.Provider value={store}>
            <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
          </WebAppStoreContext.Provider>,
        );
        await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

        fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));

        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
      });

      it("focus returns to the row's Delete button after Cancel", async () => {
        const { store } = buildStore([summary({ id: 'conv-1', title: 'Mobile launch check' })]);

        render(
          <WebAppStoreContext.Provider value={store}>
            <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
          </WebAppStoreContext.Provider>,
        );
        await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

        const deleteButton = screen.getByLabelText(DELETE_ACTION_LABEL);
        fireEvent.click(deleteButton);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(document.activeElement).toBe(deleteButton);
      });

      it('after a successful delete that leaves other conversations behind, focus moves to the search input', async () => {
        const { store } = buildStore([
          summary({ id: 'conv-1', title: 'Mobile launch check' }),
          summary({ id: 'conv-2', title: 'Second' }),
        ]);

        render(
          <WebAppStoreContext.Provider value={store}>
            <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
          </WebAppStoreContext.Provider>,
        );
        await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

        const deleteButtons = screen.getAllByLabelText(DELETE_ACTION_LABEL);
        fireEvent.click(deleteButtons[0]);
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(screen.queryByText('Mobile launch check')).toBeNull());
        expect(document.activeElement).toBe(screen.getByLabelText(SEARCH_INPUT_LABEL));
      });

      it('after a successful delete that empties the list, focus moves to the list container', async () => {
        const { store } = buildStore([summary({ id: 'conv-1', title: 'Mobile launch check' })]);

        render(
          <WebAppStoreContext.Provider value={store}>
            <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
          </WebAppStoreContext.Provider>,
        );
        await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

        fireEvent.click(screen.getByLabelText(DELETE_ACTION_LABEL));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(screen.getByText(NO_CONVERSATIONS_COPY)).toBeTruthy());
        expect(document.activeElement).toBe(
          screen.getByRole('navigation', { name: 'Conversations' }),
        );
      });

      it('Escape while the confirm is open dismisses it and restores focus to the Delete button', async () => {
        const { store, deleteConversation } = buildStore([
          summary({ id: 'conv-1', title: 'Mobile launch check' }),
        ]);

        render(
          <WebAppStoreContext.Provider value={store}>
            <ConversationList selectedConversationId={null} onSelect={vi.fn()} />
          </WebAppStoreContext.Provider>,
        );
        await waitFor(() => expect(screen.getByText('Mobile launch check')).toBeTruthy());

        const deleteButton = screen.getByLabelText(DELETE_ACTION_LABEL);
        fireEvent.click(deleteButton);
        fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });

        expect(screen.queryByText(DELETE_CONFIRM_COPY)).toBeNull();
        expect(deleteConversation).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(deleteButton);
      });
    });
  });
});
