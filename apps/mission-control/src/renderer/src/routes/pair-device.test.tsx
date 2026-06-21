import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { mockApi } from '../../../../vitest.setup.js';
import { PairDevice } from './pair-device.js';

describe('PairDevice', () => {
  describe('LAN pairing', () => {
    beforeEach(() => {
      mockApi.pairingGetInfo.mockResolvedValue({
        mode: 'lan',
        host: '192.168.1.50',
        mgmtPort: 9300,
        chatPort: 9200,
        mgmtToken: 'm-tok-secret',
        chatToken: 'c-tok-secret',
      });
    });

    it('renders a QR code from the pairing info', async () => {
      render(<PairDevice />);
      const qr = await screen.findByTestId('pairing-qr');
      expect(qr).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));
    });

    it('shows the gateway host + a local-network label but never the raw tokens', async () => {
      render(<PairDevice />);
      expect(await screen.findByText(/192\.168\.1\.50/)).toBeInTheDocument();
      expect(screen.getByTestId('pairing-mode')).toHaveTextContent('local network');
      expect(screen.queryByText(/m-tok-secret/)).not.toBeInTheDocument();
      expect(screen.queryByText(/c-tok-secret/)).not.toBeInTheDocument();
    });
  });

  describe('relay pairing', () => {
    beforeEach(() => {
      mockApi.pairingGetInfo.mockResolvedValue({
        mode: 'relay',
        host: 'gw-1.relay.example.com',
        secure: true,
        mgmtToken: 'm-tok-secret',
        chatToken: 'c-tok-secret',
        relayCredential: 'relay-cred-secret',
      });
    });

    it('renders a QR code and a relay label', async () => {
      render(<PairDevice />);
      const qr = await screen.findByTestId('pairing-qr');
      expect(qr).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));
      expect(await screen.findByText('gw-1.relay.example.com')).toBeInTheDocument();
      expect(screen.getByTestId('pairing-mode')).toHaveTextContent('relay');
    });

    it('never shows the tokens or the relay credential as text', async () => {
      render(<PairDevice />);
      await screen.findByTestId('pairing-qr');
      expect(screen.queryByText(/m-tok-secret/)).not.toBeInTheDocument();
      expect(screen.queryByText(/c-tok-secret/)).not.toBeInTheDocument();
      expect(screen.queryByText(/relay-cred-secret/)).not.toBeInTheDocument();
    });
  });
});
