import type { ConversationSummary } from '@dash/mobile-contract';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatSocket, FrameHandler } from '../api/chat-socket.js';
import type { MobileRestClient } from '../api/rest.js';
import { createWebAppStore } from '../state/store.js';
import { ConversationList, NO_CONVERSATIONS_COPY } from './ConversationList.js';
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

function buildStore(conversations: ConversationSummary[]) {
  const rest = {
    listConversations: vi.fn(async () => ({ items: conversations, nextCursor: null })),
    getMessages: vi.fn(async () => ({ items: [], nextCursor: null, throughSeq: 0 })),
  } as unknown as MobileRestClient;
  const factory = vi.fn(
    (_onFrame: FrameHandler, _onClose: (reason: 'error' | 'closed') => void) => ({}) as ChatSocket,
  );
  return {
    store: createWebAppStore({ rest, socketFactory: factory }),
    listConversations: rest.listConversations,
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
});
