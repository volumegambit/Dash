import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KeyDeleteModal } from './KeyDeleteModal.js';

describe('KeyDeleteModal', () => {
  const defaultProps = {
    provider: 'anthropic' as const,
    keyName: 'default',
    affectedAgents: [
      { deploymentId: 'd1', name: 'agent-1' },
      { deploymentId: 'd2', name: 'agent-2' },
    ],
    availableKeys: ['backup', 'work'],
    onConfirm: vi.fn(),
    onClose: vi.fn(),
  };

  it('shows affected agent names', () => {
    render(<KeyDeleteModal {...defaultProps} />);
    expect(screen.getByText('agent-1')).toBeInTheDocument();
    expect(screen.getByText('agent-2')).toBeInTheDocument();
  });

  it('shows replacement key dropdown', () => {
    render(<KeyDeleteModal {...defaultProps} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('calls onConfirm with assignments when Remove & Reassign is clicked', async () => {
    const user = userEvent.setup();
    render(<KeyDeleteModal {...defaultProps} />);
    await user.selectOptions(screen.getByRole('combobox'), 'backup');
    await user.click(screen.getByText('Remove & Reassign'));
    expect(defaultProps.onConfirm).toHaveBeenCalledWith([
      { deploymentId: 'd1', newKeyName: 'backup' },
      { deploymentId: 'd2', newKeyName: 'backup' },
    ]);
  });

  it('shows Remove Anyway when no replacement selected', () => {
    render(<KeyDeleteModal {...defaultProps} availableKeys={[]} />);
    expect(screen.getByText('Remove Anyway')).toBeInTheDocument();
  });

  it('shows individual assignment toggle', async () => {
    const user = userEvent.setup();
    render(<KeyDeleteModal {...defaultProps} />);
    await user.click(screen.getByText('Assign individually'));
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(2); // one per agent
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<KeyDeleteModal {...defaultProps} />);
    await user.click(screen.getByText('Cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
