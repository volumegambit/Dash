import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../vitest.setup.js';
import { DeviceSettings } from './devices.js';

describe('DeviceSettings', () => {
  function arrangeRelayPairing(pairingId = 'dev-1'): void {
    mockApi.pairingGetInfo.mockResolvedValue({
      mode: 'relay',
      host: 'gw-1.relay.example.com',
      secure: true,
      mgmtToken: 'mobile-token-secret',
      chatToken: 'mobile-token-secret',
      relayCredential: 'relay-credential-secret',
      pairingId,
    });
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: true,
      subdomain: 'gw-1.relay.example.com',
    });
    mockApi.devicesList.mockResolvedValue([{ id: 'dev-1', label: 'iPhone' }]);
    mockApi.devicesRevoke.mockResolvedValue(undefined);
  }

  it('refreshes the pairing QR after revoking the device represented by it', async () => {
    arrangeRelayPairing();
    const user = userEvent.setup();

    render(<DeviceSettings />);

    await screen.findByTestId('pairing-qr');
    expect(mockApi.pairingGetInfo).toHaveBeenCalledOnce();

    await user.click(await screen.findByRole('button', { name: 'Revoke iPhone' }));
    await waitFor(() => expect(mockApi.devicesRevoke).toHaveBeenCalledWith('dev-1'));
    await waitFor(() => expect(mockApi.pairingGetInfo).toHaveBeenCalledTimes(2));
  });

  it('keeps the pairing QR after revoking a different paired device', async () => {
    arrangeRelayPairing('dev-qr');
    const user = userEvent.setup();

    render(<DeviceSettings />);

    await screen.findByTestId('pairing-qr');
    expect(mockApi.pairingGetInfo).toHaveBeenCalledOnce();

    await user.click(await screen.findByRole('button', { name: 'Revoke iPhone' }));
    await waitFor(() => expect(mockApi.devicesRevoke).toHaveBeenCalledWith('dev-1'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Revoke iPhone' })).toBeEnabled(),
    );
    expect(mockApi.pairingGetInfo).toHaveBeenCalledOnce();
  });

  it('adds the newly minted QR pairing to the revocable list after the initial list loads', async () => {
    let resolvePairing!: (value: {
      mode: 'relay';
      host: string;
      secure: true;
      mgmtToken: string;
      chatToken: string;
      relayCredential: string;
      pairingId: string;
    }) => void;
    mockApi.pairingGetInfo.mockReturnValue(
      new Promise((resolve) => {
        resolvePairing = resolve;
      }),
    );
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: true,
      subdomain: 'gw-1.relay.example.com',
    });
    mockApi.devicesList.mockResolvedValue([]);
    mockApi.devicesRevoke.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<DeviceSettings />);

    await screen.findByText('No devices paired yet.');
    expect(mockApi.devicesList).toHaveBeenCalledOnce();

    resolvePairing({
      mode: 'relay',
      host: 'gw-1.relay.example.com',
      secure: true,
      mgmtToken: 'mobile-token-secret',
      chatToken: 'mobile-token-secret',
      relayCredential: 'new-relay-credential',
      pairingId: 'new-qr-pairing',
    });

    await screen.findByTestId('pairing-qr');
    const revoke = await screen.findByRole('button', { name: 'Revoke new-qr-pairing' });
    await user.click(revoke);
    await waitFor(() => expect(mockApi.devicesRevoke).toHaveBeenCalledWith('new-qr-pairing'));
  });

  it('refreshes the pairing QR after relay enrollment changes its mode', async () => {
    mockApi.pairingGetInfo
      .mockResolvedValueOnce({
        mode: 'lan',
        host: '192.168.1.50',
        secure: true,
        mgmtPort: 9400,
        chatPort: 9400,
        mgmtToken: 'mobile-token-secret',
        chatToken: 'mobile-token-secret',
        tlsCertificateSha256: 'c'.repeat(64),
      })
      .mockResolvedValueOnce({
        mode: 'relay',
        host: 'gw-1.relay.example.com',
        secure: true,
        mgmtToken: 'mobile-token-secret',
        chatToken: 'mobile-token-secret',
        relayCredential: 'relay-credential-secret',
        pairingId: 'dev-qr',
      });
    mockApi.controlPlaneStatus.mockResolvedValue({
      signedIn: true,
      enrolled: false,
      subdomain: null,
    });
    mockApi.subdomainCheck.mockResolvedValue(true);
    mockApi.gatewayEnroll.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<DeviceSettings />);

    await screen.findByTestId('pairing-qr');
    await user.type(await screen.findByTestId('subdomain-input'), 'alice-mbp');
    await waitFor(() => expect(mockApi.subdomainCheck).toHaveBeenCalledWith('alice-mbp'));
    await user.click(screen.getByRole('button', { name: 'Claim & enable' }));

    await waitFor(() => expect(mockApi.gatewayEnroll).toHaveBeenCalledWith('alice-mbp'));
    await waitFor(() => expect(mockApi.pairingGetInfo).toHaveBeenCalledTimes(2));
  });
});
