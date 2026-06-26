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

  it('shows the subdomain picker when signed in but not enrolled', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: false,
      subdomain: null,
    });
    render(<RelaySettings />);
    expect(await screen.findByTestId('subdomain-input')).toBeInTheDocument();
    expect(screen.getByTestId('relay-signedin')).toBeInTheDocument();
  });

  it('checks availability as the user types and enrolls with the chosen label', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: false,
      subdomain: null,
    });
    mockApi.subdomainCheck.mockResolvedValue(true);
    mockApi.gatewayEnroll.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RelaySettings />);

    const input = await screen.findByTestId('subdomain-input');
    await user.type(input, 'alice-mbp');
    await waitFor(() => expect(mockApi.subdomainCheck).toHaveBeenCalledWith('alice-mbp'));
    expect(await screen.findByTestId('subdomain-hint')).toHaveTextContent(/available/i);

    await user.click(screen.getByRole('button', { name: /claim & enable/i }));
    await waitFor(() => expect(mockApi.gatewayEnroll).toHaveBeenCalledWith('alice-mbp'));
  });

  it('rejects a DNS-unsafe label client-side without calling the control plane', async () => {
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: false,
      subdomain: null,
    });
    const user = userEvent.setup();
    render(<RelaySettings />);

    const input = await screen.findByTestId('subdomain-input');
    await user.type(input, 'Bad_Label');
    expect(await screen.findByTestId('subdomain-hint')).toHaveTextContent(/letters, numbers/i);
    expect(mockApi.subdomainCheck).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /claim & enable/i })).toBeDisabled();
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
