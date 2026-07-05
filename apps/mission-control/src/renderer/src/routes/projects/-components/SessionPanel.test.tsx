import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../../vitest.setup.js';
import { useChatStore } from '../../../stores/chat.js';
import { SessionPanel } from './SessionPanel.js';

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

function userMsg(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    content: { type: 'user' as const, text },
    timestamp: '2026-07-05T00:00:00Z',
  };
}

function assistantMsg(id: string, text: string) {
  return {
    id,
    role: 'assistant' as const,
    content: {
      type: 'assistant' as const,
      events: [{ type: 'text_delta' as const, text }],
    },
    timestamp: '2026-07-05T00:00:01Z',
  };
}

beforeEach(() => {
  useChatStore.setState({ messages: {}, sending: {}, streamingEvents: {} });
});

describe('SessionPanel', () => {
  it('loads and renders the conversation transcript', async () => {
    mockApi.chatGetMessages.mockResolvedValue([
      userMsg('m1', 'kickoff text'),
      assistantMsg('m2', 'I loaded TASK-2'),
    ]);
    render(<SessionPanel conversationId="conv-42" />);

    expect(await screen.findByText('kickoff text')).toBeInTheDocument();
    expect(screen.getByText(/I loaded TASK-2/)).toBeInTheDocument();
    expect(mockApi.chatGetMessages).toHaveBeenCalledWith('conv-42');
  });

  it('sends a reply through the chat store composer', async () => {
    useChatStore.setState({ messages: { 'conv-42': [] } });
    render(<SessionPanel conversationId="conv-42" />);

    const box = screen.getByPlaceholderText('Reply to the agent…');
    await userEvent.type(box, 'the goal is X{Enter}');

    await waitFor(() =>
      expect(mockApi.chatSend).toHaveBeenCalledWith('conv-42', 'the goal is X', undefined),
    );
    // Optimistic user message appears immediately.
    expect(screen.getByText('the goal is X')).toBeInTheDocument();
  });

  it('disables the composer while a reply is streaming', () => {
    useChatStore.setState({
      messages: { 'conv-42': [] },
      sending: { 'conv-42': true },
    });
    render(<SessionPanel conversationId="conv-42" />);

    expect(screen.getByPlaceholderText('Reply to the agent…')).toBeDisabled();
  });

  it('renders live streaming events for the conversation', () => {
    useChatStore.setState({
      messages: { 'conv-42': [] },
      streamingEvents: {
        'conv-42': [{ type: 'text_delta', text: 'thinking…' }],
      },
      sending: { 'conv-42': true },
    });
    render(<SessionPanel conversationId="conv-42" />);

    expect(screen.getByText(/thinking…/)).toBeInTheDocument();
  });
});
