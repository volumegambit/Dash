import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { GatewayRuntimeSettings } from './GatewayRuntimeSettings.js';

describe('GatewayRuntimeSettings', () => {
  it('shows the active local gateway status', async () => {
    mockApi.gatewayConnectionGet.mockResolvedValue({
      profile: { mode: 'local' },
      hasRemoteSecrets: false,
      health: 'healthy',
    });

    render(<GatewayRuntimeSettings />);

    expect(await screen.findByTestId('gateway-runtime-status')).toHaveTextContent(
      'Local gateway - healthy',
    );
  });

  it('saves a relay endpoint with tokens and relay credential', async () => {
    const user = userEvent.setup();
    render(<GatewayRuntimeSettings />);

    await user.type(screen.getByLabelText('Name'), 'prod');
    await user.type(screen.getByLabelText('Management URL'), 'https://gw.relay.example.com');
    await user.type(screen.getByLabelText('Chat URL'), 'wss://gw.relay.example.com');
    await user.type(screen.getByLabelText('Management token'), 'mgmt-token');
    await user.type(screen.getByLabelText('Chat token'), 'chat-token');
    await user.type(screen.getByLabelText('Relay credential'), 'relay-cred');
    await user.click(screen.getByRole('button', { name: /save endpoint/i }));

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

  it('deploys a VPS gateway with required SSH and relay fields', async () => {
    const user = userEvent.setup();
    render(<GatewayRuntimeSettings />);

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

  it('switches back to the local gateway', async () => {
    const user = userEvent.setup();
    render(<GatewayRuntimeSettings />);

    await user.click(await screen.findByRole('button', { name: /use local/i }));

    expect(mockApi.gatewayConnectionUseLocal).toHaveBeenCalled();
  });
});
