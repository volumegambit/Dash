import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { RelaySettings } from './RelaySettings.js';

describe('RelaySettings', () => {
  it('shows "Sign in to Dash" when signed out', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: false,
      enrolled: false,
      subdomain: null,
    });
    render(<RelaySettings />);
    expect(await screen.findByRole('button', { name: /sign in to dash/i })).toBeInTheDocument();
    expect(screen.queryByTestId('relay-status')).not.toBeInTheDocument();
  });

  it('offers "Create gateway" when signed in but not enrolled', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: false,
      subdomain: null,
    });
    render(<RelaySettings />);
    expect(await screen.findByRole('button', { name: /create gateway/i })).toBeInTheDocument();
    expect(screen.getByTestId('relay-signedin')).toBeInTheDocument();
  });

  it('shows the enrolled subdomain and paired devices when connected', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: true,
      subdomain: 'gw-1.relay.example.com',
    });
    mockApi.devicesList.mockResolvedValue([{ id: 'dev-1', label: 'Pixel 9' }]);
    render(<RelaySettings />);
    expect(await screen.findByTestId('relay-status')).toHaveTextContent('gw-1.relay.example.com');
    expect(await screen.findByText('Pixel 9')).toBeInTheDocument();
  });

  it('revokes a device via devicesRevoke', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: true,
      subdomain: 'gw-1.relay.example.com',
    });
    mockApi.devicesList.mockResolvedValue([{ id: 'dev-1', label: 'Pixel 9' }]);
    mockApi.devicesRevoke.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RelaySettings />);

    await user.click(await screen.findByRole('button', { name: /revoke pixel 9/i }));
    await waitFor(() => expect(mockApi.devicesRevoke).toHaveBeenCalledWith('dev-1'));
  });

  it('surfaces a sign-in error from the main process', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: false,
      enrolled: false,
      subdomain: null,
    });
    mockApi.controlPlaneSignIn.mockRejectedValue(new Error('browser launch failed'));
    const user = userEvent.setup();
    render(<RelaySettings />);

    await user.click(await screen.findByRole('button', { name: /sign in to dash/i }));
    expect(await screen.findByText(/browser launch failed/i)).toBeInTheDocument();
  });
});
