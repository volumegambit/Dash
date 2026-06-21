import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { mockApi } from '../../../../vitest.setup.js';
import { PairDevice } from './pair-device.js';

describe('PairDevice', () => {
  beforeEach(() => {
    mockApi.pairingGetInfo.mockResolvedValue({
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

  it('shows the gateway host but never the raw tokens', async () => {
    render(<PairDevice />);
    expect(await screen.findByText(/192\.168\.1\.50/)).toBeInTheDocument();
    expect(screen.queryByText(/m-tok-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/c-tok-secret/)).not.toBeInTheDocument();
  });
});
