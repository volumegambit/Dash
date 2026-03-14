import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { AiProviders } from './connections.js';

describe('AiProviders page', () => {
  beforeEach(() => {
    // Default: unlocked, anthropic has one key, others have none
    mockApi.secretsIsUnlocked.mockResolvedValue(true);
    mockApi.secretsList.mockResolvedValue(['anthropic-api-key:default']);
    mockApi.secretsGet.mockImplementation((key: string) =>
      Promise.resolve(key === 'anthropic-api-key:default' ? 'sk-ant-abc123secretkey' : null),
    );
  });

  it('shows connected status indicator for providers with a key', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      expect(screen.getByText('Claude by Anthropic')).toBeInTheDocument();
    });
    // Connected provider shows key name and masked value in key row
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
    // Click the second Add Key button (OpenAI)
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

  it('shows locked banner and does not call secretsGet when store is locked', async () => {
    mockApi.secretsIsUnlocked.mockResolvedValue(false);
    render(<AiProviders />);
    await waitFor(() => {
      expect(
        screen.getByText(
          'Secrets are locked. Unlock your secrets store to view provider status.',
        ),
      ).toBeInTheDocument();
    });
    expect(mockApi.secretsGet).not.toHaveBeenCalled();
  });

  it('calls secretsDelete and refreshes when disconnect confirmed', async () => {
    const user = userEvent.setup();
    mockApi.secretsDelete.mockResolvedValue(undefined);
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Remove'));
    await user.click(screen.getByText('Remove'));
    await user.click(screen.getByText('Yes, remove'));
    expect(mockApi.secretsDelete).toHaveBeenCalledWith('anthropic-api-key:default');
  });

  it('pre-fills key name as default when provider has no keys', async () => {
    const user = userEvent.setup();
    mockApi.secretsList.mockResolvedValue([]);
    mockApi.secretsGet.mockResolvedValue(null);
    render(<AiProviders />);
    await waitFor(() => screen.getAllByText('Add Key'));
    // Click Add Key for Anthropic (first provider, no existing keys)
    await user.click(screen.getAllByText('Add Key')[0]);
    const keyNameInput = screen.getByLabelText('Key name');
    expect(keyNameInput).toHaveValue('default');
  });
});
