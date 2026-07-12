import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { useAgentsStore } from '../stores/agents.js';
import { useChatStore } from '../stores/chat.js';
import { useUIStore } from '../stores/ui.js';
import { Companion } from './Companion.js';

/**
 * Seed the chat + agents stores with a single working session so
 * selectCompanionSessions yields exactly one `working` status.
 */
function seedOneWorkingSession(): void {
  useAgentsStore.setState({ agents: [{ id: 'a1', name: 'Ops Bot' } as never] });
  useChatStore.setState({
    conversations: [
      {
        id: 'c1',
        agentId: 'a1',
        agentName: 'Ops Bot',
        title: 'T-c1',
        revision: 1,
        status: 'running',
        activeTurnId: 'turn-c1',
        owningIssueId: null,
        projectId: null,
        lastSeq: 1,
        lastMessagePreview: null,
        createdAt: '2026-06-21T10:00:00.000Z',
        updatedAt: '2026-06-21T10:00:00.000Z',
        origin: 'gateway',
        offline: false,
        readOnly: false,
      } as never,
    ],
    selectedConversationRef: null,
    messages: {},
    streamingFrames: {
      'gateway:c1': [
        {
          type: 'event',
          id: 'turn-c1',
          conversationId: 'c1',
          seq: 1,
          event: { type: 'text_delta', text: 'thinking' },
        },
      ],
    },
    sending: { 'gateway:c1': true },
    unreadConversations: new Set(),
  });
}

describe('Companion (headless publisher)', () => {
  afterEach(() => {
    useUIStore.setState({ companionVisible: true });
  });

  it('publishes per-agent status entries on mount and renders no DOM', () => {
    seedOneWorkingSession();
    useUIStore.setState({ companionVisible: true });

    const { container } = render(<Companion />);

    expect(container.firstChild).toBeNull();
    expect(mockApi.companionPublishStatuses).toHaveBeenCalledWith([
      { agentId: 'a1', agentName: 'Ops Bot', status: 'working', preview: 'thinking' },
    ]);
  });

  it('re-publishes when a replay is requested (widget just opened)', () => {
    seedOneWorkingSession();
    useUIStore.setState({ companionVisible: true });

    let replay: (() => void) | undefined;
    mockApi.onCompanionReplayRequest.mockImplementation((cb: () => void) => {
      replay = cb;
      return () => {};
    });

    render(<Companion />);
    mockApi.companionPublishStatuses.mockClear();

    expect(replay).toBeTypeOf('function');
    replay?.();

    expect(mockApi.companionPublishStatuses).toHaveBeenCalledWith([
      { agentId: 'a1', agentName: 'Ops Bot', status: 'working', preview: 'thinking' },
    ]);
  });

  it('publishes the selected pet when visible and on replay', () => {
    seedOneWorkingSession();
    useUIStore.setState({ companionVisible: true, companionSelection: 'cat' });

    let replay: (() => void) | undefined;
    mockApi.onCompanionReplayRequest.mockImplementation((cb: () => void) => {
      replay = cb;
      return () => {};
    });

    render(<Companion />);

    expect(mockApi.companionPublishPet).toHaveBeenCalledWith('cat');
    mockApi.companionPublishPet.mockClear();

    expect(replay).toBeTypeOf('function');
    replay?.();

    expect(mockApi.companionPublishPet).toHaveBeenCalledWith('cat');
  });

  it('keeps the widget window in sync with the visibility preference', () => {
    seedOneWorkingSession();
    useUIStore.setState({ companionVisible: true });

    render(<Companion />);

    expect(mockApi.companionSetVisible).toHaveBeenCalledWith(true);
  });

  it('does not publish when the companion is hidden', () => {
    seedOneWorkingSession();
    useUIStore.setState({ companionVisible: false });

    render(<Companion />);

    expect(mockApi.companionSetVisible).toHaveBeenCalledWith(false);
    expect(mockApi.companionPublishStatuses).not.toHaveBeenCalled();
  });
});
