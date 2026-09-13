import '@testing-library/jest-dom/vitest';
import type { MemoryContent, MemoryInfo } from '@dash/management';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { mockApi } from '../../../../../../vitest.setup.js';
import { useAgentMemoryStore } from '../../../stores/agent-memory.js';
import { MemoryConfigStrip, MemoryList, MemoryTab } from './MemoryTab.js';

const memory = (over: Partial<MemoryInfo> & Pick<MemoryInfo, 'name' | 'type'>): MemoryInfo => ({
  description: 'A memory',
  source: 'agent',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  size: 5,
  ...over,
});

describe('MemoryConfigStrip', () => {
  it('shows the automatic-memory toggle and the sweep selector and saves changes', () => {
    const onSave = vi.fn();
    render(<MemoryConfigStrip config={{ enabled: true, sweep: 'auto' }} onSave={onSave} />);
    expect(screen.getByLabelText('Automatic memory')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Post-turn sweep'), { target: { value: 'off' } });
    expect(onSave).toHaveBeenCalledWith({ sweep: 'off' });
  });

  it('saves the enabled flag when the checkbox is toggled off', () => {
    const onSave = vi.fn();
    render(<MemoryConfigStrip config={{ enabled: true, sweep: 'auto' }} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText('Automatic memory'));
    expect(onSave).toHaveBeenCalledWith({ enabled: false });
  });

  it('reflects the current sweep value', () => {
    render(<MemoryConfigStrip config={{ enabled: false, sweep: 'on' }} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Automatic memory')).not.toBeChecked();
    expect(screen.getByLabelText('Post-turn sweep')).toHaveValue('on');
  });
});

describe('MemoryList', () => {
  it('groups memories by type with per-bucket counts', () => {
    const onRemove = vi.fn();
    render(
      <MemoryList
        memories={[
          memory({
            name: 'user-timezone',
            description: 'Gerry is in Singapore',
            type: 'user',
            source: 'agent',
          }),
          memory({
            name: 'repo-pnpm',
            description: 'Repo uses pnpm',
            type: 'project',
            source: 'sweep',
          }),
        ]}
        onOpen={vi.fn()}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    // Per-bucket counts are shown in the heading
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    // Each bucket has 1 item, shown as count in the heading
    const counts = screen
      .getAllByText('(', { exact: false })
      .filter((el) => el.textContent?.match(/\(1\)/));
    expect(counts.length).toBeGreaterThanOrEqual(2);
  });

  it('omits empty groups and orders groups user, feedback, project, reference', () => {
    render(
      <MemoryList
        memories={[
          memory({ name: 'ref-1', type: 'reference' }),
          memory({ name: 'proj-1', type: 'project' }),
          memory({ name: 'fb-1', type: 'feedback' }),
        ]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.queryByText('User')).not.toBeInTheDocument();
    // Headings include the count suffix, so match on the heading role
    const headings = screen.getAllByRole('heading').map((h) => {
      const text = h.textContent ?? '';
      // Strip the count suffix to get just the type label
      return text.replace(/\s*\(\d+\)\s*$/, '').trim();
    });
    expect(headings).toEqual(['Feedback', 'Project', 'Reference']);
  });

  it('shows the source of each memory', () => {
    render(
      <MemoryList
        memories={[memory({ name: 'user-timezone', type: 'user', source: 'sweep' })]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText(/sweep/)).toBeInTheDocument();
  });

  it('expands a memory row to show updatedAt and edit/delete actions', () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <MemoryList
        memories={[
          memory({
            name: 'user-timezone',
            type: 'user',
            source: 'agent',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        ]}
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );
    // Click the memory name to expand the row
    fireEvent.click(screen.getByText('user-timezone'));
    // Expanded state shows updatedAt, Edit, and Delete
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();

    // Edit calls onOpen
    fireEvent.click(screen.getByText('Edit'));
    expect(onOpen).toHaveBeenCalledWith('user-timezone');

    // Delete calls onRemove
    fireEvent.click(screen.getAllByText('Delete')[0]);
    expect(onRemove).toHaveBeenCalledWith('user-timezone');
  });

  it('collapses an expanded row when clicked again', () => {
    render(
      <MemoryList
        memories={[memory({ name: 'user-timezone', type: 'user' })]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('user-timezone'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    // Click again to collapse
    fireEvent.click(screen.getByText('user-timezone'));
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no memories', () => {
    render(<MemoryList memories={[]} onOpen={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText(/No memories yet/)).toBeInTheDocument();
  });

  it('shows a search filter when there are more than 5 memories', () => {
    const many = Array.from({ length: 6 }, (_, i) => memory({ name: `mem-${i}`, type: 'user' }));
    render(<MemoryList memories={many} onOpen={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByPlaceholderText('Filter memories…')).toBeInTheDocument();
  });

  it('does not show a search filter for 5 or fewer memories', () => {
    render(
      <MemoryList
        memories={[memory({ name: 'mem-1', type: 'user' })]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText('Filter memories…')).not.toBeInTheDocument();
  });

  it('filters memories by name and description', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      memory({ name: `mem-${i}`, description: `desc-${i}`, type: 'user' }),
    );
    many[0] = memory({ name: 'user-timezone', description: 'Singapore timezone', type: 'user' });
    many[1] = memory({ name: 'repo-pnpm', description: 'Uses pnpm', type: 'project' });
    render(<MemoryList memories={many} onOpen={vi.fn()} onRemove={vi.fn()} />);
    const search = screen.getByPlaceholderText('Filter memories…');
    fireEvent.change(search, { target: { value: 'singapore' } });
    expect(screen.getByText('user-timezone')).toBeInTheDocument();
    expect(screen.queryByText('repo-pnpm')).not.toBeInTheDocument();
  });
});

describe('MemoryTab', () => {
  beforeEach(() => {
    // Reset the module-global zustand store so one test's agent data can't leak
    // into the next render.
    useAgentMemoryStore.setState({
      memories: [],
      config: { enabled: true, sweep: 'auto' },
      loading: false,
      error: null,
    });
  });

  it('closes the editor when the memory being edited is deleted', async () => {
    mockApi.memoryList.mockResolvedValueOnce([
      memory({ name: 'user-timezone', description: 'Gerry is in Singapore', type: 'user' }),
    ]);
    mockApi.memoryList.mockResolvedValue([]);
    mockApi.memoryGet.mockResolvedValue({
      name: 'user-timezone',
      description: 'Gerry is in Singapore',
      type: 'user',
      source: 'agent',
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
      content: 'Gerry lives in Singapore.',
    } satisfies MemoryContent);

    render(<MemoryTab agentId="agent-a" />);

    // Expand the row, then click Edit to open the modal
    fireEvent.click(await screen.findByText('user-timezone'));
    fireEvent.click(screen.getByText('Edit'));
    expect(await screen.findByLabelText('Content')).toBeInTheDocument();

    // Close the modal
    fireEvent.click(screen.getByText('Cancel'));
    // Modal is closed; the row is still expanded from earlier — Delete should be visible
    await waitFor(() => expect(screen.queryByLabelText('Content')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() =>
      expect(mockApi.memoryRemove).toHaveBeenCalledWith('agent-a', 'user-timezone'),
    );
    await waitFor(() => expect(screen.queryByLabelText('Content')).not.toBeInTheDocument());
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(mockApi.memoryPut).not.toHaveBeenCalled();
  });

  it('does not render the previous agent memories or config after switching agent', async () => {
    mockApi.memoryList.mockImplementation((agentId: string) =>
      agentId === 'agent-a'
        ? Promise.resolve([memory({ name: 'a-only-memory', type: 'user' })])
        : new Promise(() => {}),
    );
    mockApi.memoryGetConfig.mockImplementation((agentId: string) =>
      agentId === 'agent-a'
        ? Promise.resolve({ enabled: false, sweep: 'off' })
        : new Promise(() => {}),
    );

    const { rerender } = render(<MemoryTab agentId="agent-a" />);
    expect(await screen.findByText('a-only-memory')).toBeInTheDocument();

    rerender(<MemoryTab agentId="agent-b" />);

    await waitFor(() => expect(screen.queryByText('a-only-memory')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Automatic memory')).not.toBeInTheDocument();
  });
});
