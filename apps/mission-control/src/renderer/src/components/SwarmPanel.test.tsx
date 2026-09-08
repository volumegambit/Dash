import '@testing-library/jest-dom/vitest';
import type { SubagentListEntry } from '@dash/mobile-contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../../vitest.setup.js';
import { useChatStore } from '../stores/chat.js';
import { SwarmPanel } from './SwarmPanel.js';

const START = '2026-09-04T00:00:00.000Z';
const END = '2026-09-04T00:00:45.000Z';

function entry(over: Partial<SubagentListEntry> = {}): SubagentListEntry {
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
  };
}

beforeEach(() => {
  vi.useRealTimers();
  mockApi.subagentsList.mockReset();
  mockApi.subagentsList.mockResolvedValue([]);
  mockApi.subagentStop.mockReset();
  mockApi.subagentStop.mockResolvedValue({ ok: true, status: 'cancelled' });
  mockApi.subagentResume.mockReset();
  mockApi.subagentResume.mockResolvedValue({ ok: true, status: 'running', mode: 'queued' });
  useChatStore.setState({
    subagents: [],
    subagentUi: {},
    selectedConversationRef: { id: 'parent-1', origin: 'gateway' },
  });
});

afterEach(() => {
  cleanup();
});

describe('SwarmPanel', () => {
  it("lists the conversation's children rather than the agent's runs", () => {
    useChatStore.setState({
      subagents: [entry(), entry({ id: 'sub_b', type: 'Explore', status: 'done', endedAt: END })],
    });

    render(<SwarmPanel onClose={() => undefined} />);

    expect(screen.getByTestId('swarm-panel')).toBeInTheDocument();
    const first = screen.getByTestId('swarm-subagent-sub_a');
    expect(first).toHaveTextContent('code-reviewer');
    expect(first).toHaveTextContent('Review the diff');
    expect(first).toHaveTextContent('12 tool uses');
    expect(screen.getByTestId('swarm-subagent-sub_b')).toHaveTextContent('45s');
  });

  it('renders no elapsed for a terminal child with no endedAt', () => {
    useChatStore.setState({ subagents: [entry({ status: 'cancelled' })] });

    render(<SwarmPanel onClose={() => undefined} />);

    const row = screen.getByTestId('swarm-subagent-sub_a');
    expect(within(row).getByTestId('swarm-subagent-meta')).toHaveTextContent('12 tool uses');
    expect(within(row).getByTestId('swarm-subagent-meta').textContent).not.toContain('·');
  });

  it('shows an empty state when the conversation has no children', () => {
    render(<SwarmPanel onClose={() => undefined} />);

    expect(screen.getByText(/no sub-agents/i)).toBeInTheDocument();
    expect(screen.queryByTestId('swarm-stop-button')).not.toBeInTheDocument();
  });

  it('stops a child through the sub-agent route and re-reads the list', async () => {
    useChatStore.setState({ subagents: [entry()] });
    mockApi.subagentsList.mockResolvedValue([entry({ status: 'cancelled' })]);

    render(<SwarmPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('swarm-stop-button'));

    await waitFor(() => expect(mockApi.subagentStop).toHaveBeenCalledWith('sub_a'));
    await waitFor(() => expect(mockApi.subagentsList).toHaveBeenCalledWith('parent-1'));
  });

  it('offers no stop on a child that has already finished', () => {
    useChatStore.setState({ subagents: [entry({ status: 'done', endedAt: END })] });

    render(<SwarmPanel onClose={() => undefined} />);

    expect(screen.queryByTestId('swarm-stop-button')).not.toBeInTheDocument();
  });

  it('resumes a child through the sub-agent route, carrying a requestId', async () => {
    useChatStore.setState({ subagents: [entry({ status: 'waiting_input' })] });

    render(<SwarmPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('swarm-resume-button'));
    fireEvent.change(screen.getByTestId('swarm-resume-input-sub_a'), {
      target: { value: 'use main' },
    });
    fireEvent.click(screen.getByTestId('swarm-resume-send-sub_a'));

    await waitFor(() =>
      expect(mockApi.subagentResume).toHaveBeenCalledWith('sub_a', 'use main', expect.any(String)),
    );
  });

  // Ruling 5: the gateway's three actionable 409s must reach the user at the
  // site they clicked. This is the panel; the card is the other one.
  it.each([
    'sub-agent type Explore is one-shot and cannot be resumed',
    'the tool grant for this sub-agent can no longer be rebuilt',
    'steer cap reached (3) for this sub-agent',
  ])('renders a refused resume in the panel: %s', async (reason) => {
    useChatStore.setState({ subagents: [entry({ status: 'waiting_input' })] });
    mockApi.subagentResume.mockResolvedValue({ ok: false, reason });

    render(<SwarmPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('swarm-resume-button'));
    fireEvent.change(screen.getByTestId('swarm-resume-input-sub_a'), {
      target: { value: 'go on' },
    });
    fireEvent.click(screen.getByTestId('swarm-resume-send-sub_a'));

    const notice = await screen.findByTestId('swarm-action-notice');
    expect(notice).toHaveTextContent(reason);
  });

  it('renders a refused stop in the panel', async () => {
    useChatStore.setState({ subagents: [entry()] });
    mockApi.subagentStop.mockResolvedValue({
      ok: false,
      reason: 'Sub-agent sub_a is already done',
    });

    render(<SwarmPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('swarm-stop-button'));

    expect(await screen.findByTestId('swarm-action-notice')).toHaveTextContent(
      'Sub-agent sub_a is already done',
    );
  });

  it('dismisses a notice', async () => {
    useChatStore.setState({ subagents: [entry()] });
    mockApi.subagentStop.mockResolvedValue({ ok: false, reason: 'already done' });

    render(<SwarmPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('swarm-stop-button'));
    const notice = await screen.findByTestId('swarm-action-notice');
    fireEvent.click(within(notice).getByLabelText('Dismiss'));

    await waitFor(() =>
      expect(screen.queryByTestId('swarm-action-notice')).not.toBeInTheDocument(),
    );
  });

  it('clicking a row asks the transcript to expand that card', () => {
    useChatStore.setState({ subagents: [entry()] });

    render(<SwarmPanel onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('swarm-subagent-open-sub_a'));

    expect(useChatStore.getState().subagentUi.sub_a?.expanded).toBe(true);
  });
});

// Design §7.2: clients "subscribe to it live (§7.6) when a row is expanded or a
// tasks panel is open". Ruling 1's second half.
describe('SwarmPanel subscriptions', () => {
  const parentConversation = {
    id: 'parent-1',
    agentId: 'agent-1',
    agentName: 'Developer',
    title: 'Gateway conversation',
    revision: 2,
    status: 'idle' as const,
    activeTurnId: null,
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: '',
    createdAt: START,
    updatedAt: START,
    kind: 'user' as const,
    origin: 'gateway' as const,
    offline: false,
    readOnly: false,
  };

  it('holds a live child while it is open, and lets it go when it closes', async () => {
    useChatStore.setState({ conversations: [parentConversation], subagents: [entry()] });

    const view = render(<SwarmPanel onClose={() => undefined} />);
    await waitFor(() => expect(mockApi.subagentSubscribe).toHaveBeenCalledWith('agent-1', 'sub_a'));

    view.unmount();

    await waitFor(() => expect(mockApi.subagentUnsubscribe).toHaveBeenCalledWith('sub_a'));
  });

  // A terminal child emits nothing, so a socket for it is a socket for nothing.
  // This is the bound on ruling 5's stampede: the panel opens at most one per
  // NON-TERMINAL depth-0 child, and the design's own worked example is eight.
  it('holds nothing for a child that has already finished', async () => {
    useChatStore.setState({
      conversations: [parentConversation],
      subagents: [entry({ id: 'sub_done', status: 'done', endedAt: END })],
    });

    render(<SwarmPanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('swarm-subagent-sub_done')).toBeInTheDocument());

    expect(mockApi.subagentSubscribe).not.toHaveBeenCalled();
  });
});
