import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { AiProviders } from './connections.js';

describe('AiProviders page', () => {
  beforeEach(() => {
    // Default: anthropic has one key, others have none
    mockApi.credentialsList.mockResolvedValue(['anthropic-api-key:default']);
  });

  it('shows connected status indicator for providers with a key', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      expect(screen.getByText('Claude by Anthropic')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('default')).toBeInTheDocument();
    });
  });

  it('shows Add Key button for every provider', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      const addButtons = screen.getAllByText('Add Key');
      expect(addButtons).toHaveLength(3); // one per provider
    });
  });

  it('opens modal when Add Key is clicked for unconnected provider', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await waitFor(() => screen.getAllByText('Add Key'));
    await user.click(screen.getAllByText('Add Key')[1]);
    expect(screen.getByText('Connect to OpenAI')).toBeInTheDocument();
  });

  it('shows Update and Remove buttons for connected provider key', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
      expect(screen.getByText('Remove')).toBeInTheDocument();
    });
  });

  it('shows inline confirm when Remove is clicked', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Remove'));
    await user.click(screen.getByText('Remove'));
    expect(screen.getByText('Remove key?')).toBeInTheDocument();
    expect(screen.getByText('Yes, remove')).toBeInTheDocument();
  });

  it('calls credentialsRemove and refreshes when disconnect confirmed', async () => {
    const user = userEvent.setup();
    mockApi.credentialsRemove.mockResolvedValue(undefined);
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Remove'));
    await user.click(screen.getByText('Remove'));
    await user.click(screen.getByText('Yes, remove'));
    expect(mockApi.credentialsRemove).toHaveBeenCalledWith('anthropic-api-key:default');
  });

  it('pre-fills key name as default when provider has no keys', async () => {
    const user = userEvent.setup();
    mockApi.credentialsList.mockResolvedValue([]);
    render(<AiProviders />);
    await waitFor(() => screen.getAllByText('Add Key'));
    await user.click(screen.getAllByText('Add Key')[0]);
    const keyNameInput = screen.getByLabelText('Key name');
    expect(keyNameInput).toHaveValue('default');
  });
});
