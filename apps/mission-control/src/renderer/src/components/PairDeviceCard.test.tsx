import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { mockApi } from '../../../../vitest.setup.js';
import { PairDeviceCard, qrPayload } from './PairDeviceCard.js';

describe('PairDeviceCard', () => {
  describe('LAN pairing', () => {
    beforeEach(() => {
      mockApi.pairingGetInfo.mockResolvedValue({
        mode: 'lan',
        host: '192.168.1.50',
        secure: true,
        mgmtPort: 9400,
        chatPort: 9400,
        mgmtToken: 'mobile-token-secret',
        chatToken: 'mobile-token-secret',
        tlsCertificateSha256: 'c'.repeat(64),
      });
    });

    it('renders a QR code from the pairing info', async () => {
      render(<PairDeviceCard />);
      const qr = await screen.findByTestId('pairing-qr');
      expect(qr).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));
    });

    it('encodes pinned HTTPS LAN pairing as the v3 wire shape', async () => {
      const info = await mockApi.pairingGetInfo();
      expect(JSON.parse(qrPayload(info))).toEqual({
        v: 3,
        host: '192.168.1.50',
        secure: true,
        mgmtPort: 9400,
        chatPort: 9400,
        mgmtToken: 'mobile-token-secret',
        chatToken: 'mobile-token-secret',
        tlsCertificateSha256: 'c'.repeat(64),
      });
    });

    it('uses platform-neutral mobile pairing copy', async () => {
      render(<PairDeviceCard />);

      expect(
        await screen.findByText('Scan this code with the Dash mobile app for Android or iOS.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Dash Android app/i)).not.toBeInTheDocument();
      expect(
        await screen.findByRole('img', {
          name: 'Pairing QR code for the Dash mobile app',
        }),
      ).toBeInTheDocument();
    });

    it('shows the gateway host + a local-network label but never the raw tokens', async () => {
      render(<PairDeviceCard />);
      expect(await screen.findByText(/192\.168\.1\.50/)).toBeInTheDocument();
      expect(screen.getByTestId('pairing-mode')).toHaveTextContent('local network');
      expect(screen.queryByText(/mobile-token-secret/)).not.toBeInTheDocument();
      expect(screen.getByText(/The mobile token and pinned gateway identity/)).toBeInTheDocument();
    });
  });

  describe('relay pairing', () => {
    beforeEach(() => {
      mockApi.pairingGetInfo.mockResolvedValue({
        mode: 'relay',
        host: 'gw-1.relay.example.com',
        secure: true,
        mgmtToken: 'mobile-token-secret',
        chatToken: 'mobile-token-secret',
        relayCredential: 'relay-cred-secret',
      });
    });

    it('renders a QR code and a relay label', async () => {
      render(<PairDeviceCard />);
      const qr = await screen.findByTestId('pairing-qr');
      expect(qr).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));
      expect(await screen.findByText('gw-1.relay.example.com')).toBeInTheDocument();
      expect(screen.getByTestId('pairing-mode')).toHaveTextContent('relay');
    });

    it('never shows the tokens or the relay credential as text', async () => {
      render(<PairDeviceCard />);
      await screen.findByTestId('pairing-qr');
      expect(screen.queryByText(/mobile-token-secret/)).not.toBeInTheDocument();
      expect(screen.queryByText(/relay-cred-secret/)).not.toBeInTheDocument();
      expect(
        screen.getByText(/The mobile token and a per-device relay credential/),
      ).toBeInTheDocument();
    });
  });
});
