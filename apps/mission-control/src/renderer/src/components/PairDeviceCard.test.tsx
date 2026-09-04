import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';
import { mockApi } from '../../../../vitest.setup.js';
import type { PairingInfo } from '../../../shared/ipc.js';
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

    it('uses Android-only mobile pairing copy now that iOS connects by account sign-in', async () => {
      render(<PairDeviceCard />);

      expect(
        await screen.findByText('Scan this code with the Dash mobile app for Android.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/or iOS/i)).not.toBeInTheDocument();
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
        pairingId: 'pr-current',
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

    it('omits the renderer-only pairing id from the QR wire payload', async () => {
      const info = await mockApi.pairingGetInfo();

      expect(JSON.parse(qrPayload(info))).toEqual({
        v: 2,
        host: 'gw-1.relay.example.com',
        secure: true,
        mgmtToken: 'mobile-token-secret',
        chatToken: 'mobile-token-secret',
        relayCredential: 'relay-cred-secret',
      });
      expect(JSON.parse(qrPayload(info))).not.toHaveProperty('pairingId');
    });

    it('reports the pairing id represented by the rendered QR', async () => {
      const onPairingIdChanged = vi.fn();

      render(<PairDeviceCard onPairingIdChanged={onPairingIdChanged} />);

      await screen.findByTestId('pairing-qr');
      expect(onPairingIdChanged).toHaveBeenCalledWith('pr-current');
    });

    it('ignores an obsolete load that completes after the card is remounted', async () => {
      const staleInfo: PairingInfo = {
        mode: 'relay',
        host: 'stale.relay.example.com',
        secure: true,
        mgmtToken: 'stale-mobile-token',
        chatToken: 'stale-mobile-token',
        relayCredential: 'stale-relay-credential',
        pairingId: 'pr-stale',
      };
      const currentInfo: PairingInfo = {
        mode: 'relay',
        host: 'current.relay.example.com',
        secure: true,
        mgmtToken: 'current-mobile-token',
        chatToken: 'current-mobile-token',
        relayCredential: 'current-relay-credential',
        pairingId: 'pr-current',
      };
      let resolveStale!: (info: PairingInfo) => void;
      const staleLoad = new Promise<PairingInfo>((resolve) => {
        resolveStale = resolve;
      });
      mockApi.pairingGetInfo.mockReturnValueOnce(staleLoad).mockResolvedValueOnce(currentInfo);
      const qrSpy = vi.spyOn(QRCode, 'toString');
      const onPairingIdChanged = vi.fn();

      try {
        const { rerender } = render(
          <PairDeviceCard key="stale" onPairingIdChanged={onPairingIdChanged} />,
        );
        expect(mockApi.pairingGetInfo).toHaveBeenCalledOnce();

        rerender(<PairDeviceCard key="current" onPairingIdChanged={onPairingIdChanged} />);
        await screen.findByTestId('pairing-qr');
        expect(onPairingIdChanged).toHaveBeenCalledTimes(1);
        expect(onPairingIdChanged).toHaveBeenLastCalledWith('pr-current');

        await act(async () => {
          resolveStale(staleInfo);
          await Promise.resolve();
        });
        await waitFor(() => expect(qrSpy).toHaveBeenCalledTimes(2));
        await act(async () => {
          await qrSpy.mock.results[1].value;
          await Promise.resolve();
        });

        expect(onPairingIdChanged).toHaveBeenCalledTimes(1);
        expect(onPairingIdChanged).toHaveBeenLastCalledWith('pr-current');
      } finally {
        qrSpy.mockRestore();
      }
    });
  });
});
