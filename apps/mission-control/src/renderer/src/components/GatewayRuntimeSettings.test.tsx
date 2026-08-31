import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { GatewayRuntimeSettings } from './GatewayRuntimeSettings.js';

describe('GatewayRuntimeSettings', () => {
  it('shows a compact local gateway summary and opens the connection wizard', async () => {
    const user = userEvent.setup();
    mockApi.gatewayConnectionGet.mockResolvedValue({
      profile: { mode: 'local' },
      hasRemoteSecrets: false,
      health: 'healthy',
    });

    render(<GatewayRuntimeSettings />);

    expect(await screen.findByTestId('gateway-runtime-status')).toHaveTextContent(
      'This computer - healthy',
    );
    expect(screen.queryByLabelText('Management URL')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /change gateway/i }));

    expect(screen.getByRole('heading', { name: /choose a gateway/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use this computer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect existing gateway/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /self-host on a vps/i })).toBeInTheDocument();
    expect(screen.queryByText(/hosted dash gateway/i)).not.toBeInTheDocument();
  });

  it('shows an authenticated identity failure as reconnect-required', async () => {
    mockApi.gatewayConnectionGet.mockResolvedValue({
      profile: {
        mode: 'relay',
        name: 'prod',
        managementBaseUrl: 'https://gw.relay.example.com',
      },
      hasRemoteSecrets: true,
      health: 'unhealthy',
      issue: {
        kind: 'repair_required',
        message: 'Gateway authorization failed. Reconnect this gateway to continue.',
        retryable: false,
      },
    });

    render(<GatewayRuntimeSettings />);

    expect(await screen.findByText(/gateway authorization failed/i)).toBeInTheDocument();
    expect(screen.getByTestId('gateway-runtime-status')).toHaveTextContent(
      'prod - reconnect required',
    );
  });

  it('tests an existing gateway before enabling activation', async () => {
    const user = userEvent.setup();
    mockApi.gatewayConnectionTest.mockResolvedValueOnce({
      ok: true,
      status: {
        profile: {
          mode: 'relay',
          name: 'prod',
          managementBaseUrl: 'https://gw.relay.example.com',
          chatBaseUrl: 'wss://gw.relay.example.com',
        },
        hasRemoteSecrets: true,
        health: 'healthy',
      },
    });

    render(<GatewayRuntimeSettings />);

    await user.click(await screen.findByRole('button', { name: /change gateway/i }));
    await user.click(screen.getByRole('button', { name: /connect existing gateway/i }));
    await user.type(screen.getByLabelText('Gateway name'), 'prod');
    await user.type(screen.getByLabelText('Management URL'), 'https://gw.relay.example.com');
    await user.type(screen.getByLabelText('Chat URL'), 'wss://gw.relay.example.com');
    await user.type(screen.getByLabelText('Management token'), 'mgmt-token');
    await user.type(screen.getByLabelText('Chat token'), 'chat-token');
    await user.type(screen.getByLabelText('Relay credential'), 'relay-cred');

    const useGateway = screen.getByRole('button', { name: /use this gateway/i });
    expect(useGateway).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(mockApi.gatewayConnectionTest).toHaveBeenCalledWith({
        mode: 'relay',
        name: 'prod',
        managementBaseUrl: 'https://gw.relay.example.com',
        chatBaseUrl: 'wss://gw.relay.example.com',
        managementToken: 'mgmt-token',
        chatToken: 'chat-token',
        relayCredential: 'relay-cred',
      });
    });
    expect(await screen.findByText(/connection looks good/i)).toBeInTheDocument();
    expect(useGateway).toBeEnabled();

    await user.click(useGateway);

    await waitFor(() => {
      expect(mockApi.gatewayConnectionSaveRelay).toHaveBeenCalledWith({
        mode: 'relay',
        name: 'prod',
        managementBaseUrl: 'https://gw.relay.example.com',
        chatBaseUrl: 'wss://gw.relay.example.com',
        managementToken: 'mgmt-token',
        chatToken: 'chat-token',
        relayCredential: 'relay-cred',
      });
    });
  });

  it('keeps an existing gateway inactive when the connection test fails', async () => {
    const user = userEvent.setup();
    mockApi.gatewayConnectionTest.mockResolvedValueOnce({
      ok: false,
      message: 'Could not reach that gateway. Check the URL and tokens, then try again.',
    });

    render(<GatewayRuntimeSettings />);

    await user.click(await screen.findByRole('button', { name: /change gateway/i }));
    await user.click(screen.getByRole('button', { name: /connect existing gateway/i }));
    await user.type(screen.getByLabelText('Management URL'), 'https://broken.example.com');
    await user.type(screen.getByLabelText('Management token'), 'bad-mgmt');
    await user.type(screen.getByLabelText('Chat token'), 'bad-chat');
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/could not reach that gateway/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use this gateway/i })).toBeDisabled();
    expect(mockApi.gatewayConnectionSaveRelay).not.toHaveBeenCalled();
  });

  it('keeps VPS deployment behind the advanced self-host path', async () => {
    const user = userEvent.setup();
    render(<GatewayRuntimeSettings />);

    await user.click(await screen.findByRole('button', { name: /change gateway/i }));

    expect(screen.queryByLabelText('Host')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /self-host on a vps/i }));
    await user.type(screen.getByLabelText('Host'), '203.0.113.10');
    await user.type(screen.getByLabelText('User'), 'dash');
    await user.type(screen.getByLabelText('Gateway id'), 'gw-1');
    await user.type(screen.getByLabelText('Relay URL'), 'wss://relay.example.com');
    await user.type(screen.getByLabelText('Relay token'), 'relay-token');
    await user.type(screen.getByLabelText('VPS relay credential'), 'relay-cred');
    await user.click(screen.getByRole('button', { name: /deploy and connect/i }));

    await waitFor(() => {
      expect(mockApi.gatewayDeployVps).toHaveBeenCalledWith(
        expect.objectContaining({
          host: '203.0.113.10',
          user: 'dash',
          gatewayId: 'gw-1',
          relayUrl: 'wss://relay.example.com',
          relayToken: 'relay-token',
          relayCredential: 'relay-cred',
        }),
      );
    });
  });

  it('switches back to the local gateway from the summary', async () => {
    const user = userEvent.setup();
    mockApi.gatewayConnectionGet.mockResolvedValue({
      profile: {
        mode: 'relay',
        name: 'prod',
        managementBaseUrl: 'https://gw.relay.example.com',
      },
      hasRemoteSecrets: true,
      health: 'healthy',
    });

    render(<GatewayRuntimeSettings />);

    await user.click(await screen.findByRole('button', { name: /use this computer/i }));

    expect(mockApi.gatewayConnectionUseLocal).toHaveBeenCalled();
  });
});
