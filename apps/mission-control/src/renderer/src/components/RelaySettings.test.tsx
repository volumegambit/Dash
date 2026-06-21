import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { RelaySettings } from './RelaySettings.js';

describe('RelaySettings', () => {
  it('shows the not-configured state with an Enable button', async () => {
    mockApi.relayGetConfig.mockResolvedValue({ zone: null, configured: false });
    render(<RelaySettings />);
    expect(await screen.findByRole('button', { name: /enable relay/i })).toBeInTheDocument();
    expect(screen.queryByTestId('relay-status')).not.toBeInTheDocument();
    // No Disable button until configured.
    expect(screen.queryByRole('button', { name: /disable relay/i })).not.toBeInTheDocument();
  });

  it('shows the configured zone and a Disable button when relay mode is on', async () => {
    mockApi.relayGetConfig.mockResolvedValue({ zone: 'relay.example.com', configured: true });
    render(<RelaySettings />);
    expect(await screen.findByTestId('relay-status')).toHaveTextContent('relay.example.com');
    expect(screen.getByRole('button', { name: /disable relay/i })).toBeInTheDocument();
  });

  it('saves the entered config via relaySetConfig and clears the secret inputs', async () => {
    mockApi.relayGetConfig.mockResolvedValue({ zone: null, configured: false });
    mockApi.relaySetConfig.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RelaySettings />);

    await user.type(await screen.findByLabelText('Relay domain'), 'relay.example.com');
    await user.type(screen.getByLabelText('Relay token'), 'shared-token');
    await user.type(screen.getByLabelText('Admin secret'), 'admin-secret');
    await user.click(screen.getByRole('button', { name: /enable relay/i }));

    await waitFor(() =>
      expect(mockApi.relaySetConfig).toHaveBeenCalledWith({
        zone: 'relay.example.com',
        relayToken: 'shared-token',
        adminSecret: 'admin-secret',
      }),
    );
    // Secrets must not linger in the inputs after saving.
    expect(screen.getByLabelText('Relay token')).toHaveValue('');
    expect(screen.getByLabelText('Admin secret')).toHaveValue('');
  });

  it('surfaces a save error from the main process', async () => {
    mockApi.relayGetConfig.mockResolvedValue({ zone: null, configured: false });
    mockApi.relaySetConfig.mockRejectedValue(new Error('relay unreachable'));
    const user = userEvent.setup();
    render(<RelaySettings />);

    await user.type(await screen.findByLabelText('Relay domain'), 'relay.example.com');
    await user.type(screen.getByLabelText('Relay token'), 't');
    await user.type(screen.getByLabelText('Admin secret'), 's');
    await user.click(screen.getByRole('button', { name: /enable relay/i }));

    expect(await screen.findByText(/relay unreachable/i)).toBeInTheDocument();
  });
});
