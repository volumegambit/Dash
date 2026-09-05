import '@testing-library/jest-dom/vitest';
import type { MemoryInfo } from '@dash/management';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryConfigStrip, MemoryList } from './MemoryTab.js';

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
  it('groups memories by type and offers delete', () => {
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
    fireEvent.click(screen.getAllByText('Delete')[0]);
    expect(onRemove).toHaveBeenCalledWith('user-timezone');
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
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['Feedback', 'Project', 'Reference']);
  });

  it('shows the source and updatedAt of each memory', () => {
    render(
      <MemoryList
        memories={[memory({ name: 'user-timezone', type: 'user', source: 'sweep' })]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText(/sweep/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-05T00:00:00.000Z/)).toBeInTheDocument();
  });

  it('opens a memory when its row is clicked', () => {
    const onOpen = vi.fn();
    render(
      <MemoryList
        memories={[memory({ name: 'user-timezone', type: 'user' })]}
        onOpen={onOpen}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('user-timezone'));
    expect(onOpen).toHaveBeenCalledWith('user-timezone');
  });

  it('renders an empty state when there are no memories', () => {
    render(<MemoryList memories={[]} onOpen={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText(/No memories yet/)).toBeInTheDocument();
  });
});
