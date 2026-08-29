import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ControlPlaneApiError, type GatewayInfo } from '../auth/control-plane.js';
import { GATEWAY_NEEDS_REENROLL_COPY, GatewayPicker } from './GatewayPicker.js';

const GATEWAY: GatewayInfo = {
  gatewayId: 'gw-1',
  subdomain: 'acme',
  status: 'active',
  createdAt: 1,
};

const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

function stubUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
}

describe('GatewayPicker', () => {
  afterEach(() => {
    stubUserAgent('');
  });

  it('renders the gateway list by subdomain', () => {
    render(
      <GatewayPicker
        gateways={[GATEWAY]}
        controlPlaneClient={{ createWebPairing: vi.fn() }}
        credentialStore={{ set: vi.fn() }}
        onReady={vi.fn()}
      />,
    );
    expect(screen.getByText('acme')).toBeTruthy();
  });

  it('renders the Mission Control pointer copy, exactly, when there are no gateways', () => {
    render(
      <GatewayPicker
        gateways={[]}
        controlPlaneClient={{ createWebPairing: vi.fn() }}
        credentialStore={{ set: vi.fn() }}
        onReady={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine.',
      ),
    ).toBeTruthy();
  });

  it('pairs with the chosen gateway, stores both the relay credential and chat token, and calls onReady', async () => {
    stubUserAgent(SAFARI_UA);
    const createWebPairing = vi.fn(async () => ({
      credential: 'cred-123',
      pairingId: 'p-1',
      chatToken: 'chat-abc',
    }));
    const set = vi.fn(async () => undefined);
    const onReady = vi.fn();

    render(
      <GatewayPicker
        gateways={[GATEWAY]}
        controlPlaneClient={{ createWebPairing }}
        credentialStore={{ set }}
        onReady={onReady}
      />,
    );

    fireEvent.click(screen.getByText('acme'));

    await waitFor(() => expect(onReady).toHaveBeenCalled());

    expect(createWebPairing).toHaveBeenCalledWith('gw-1', 'Web · Safari');
    const stored = { relayCredential: 'cred-123', chatToken: 'chat-abc' };
    expect(set).toHaveBeenCalledWith('gw-1', stored);
    expect(onReady).toHaveBeenCalledWith(GATEWAY, stored);
  });

  it('surfaces an error and re-enables the choice when pairing fails', async () => {
    stubUserAgent(SAFARI_UA);
    const createWebPairing = vi.fn(async () => {
      throw new Error('pairing failed');
    });
    const set = vi.fn();
    const onReady = vi.fn();

    render(
      <GatewayPicker
        gateways={[GATEWAY]}
        controlPlaneClient={{ createWebPairing }}
        credentialStore={{ set }}
        onReady={onReady}
      />,
    );

    fireEvent.click(screen.getByText('acme'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(set).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    const button = screen.getByText('acme').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('shows the re-enroll copy, exactly, when pairing 409s because the gateway has no chat token registered', async () => {
    stubUserAgent(SAFARI_UA);
    const createWebPairing = vi.fn(async () => {
      throw new ControlPlaneApiError(409, 'no web chat token registered for this gateway');
    });
    const set = vi.fn();
    const onReady = vi.fn();

    render(
      <GatewayPicker
        gateways={[GATEWAY]}
        controlPlaneClient={{ createWebPairing }}
        credentialStore={{ set }}
        onReady={onReady}
      />,
    );

    fireEvent.click(screen.getByText('acme'));

    await waitFor(() => expect(screen.getByText(GATEWAY_NEEDS_REENROLL_COPY)).toBeTruthy());
    expect(set).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });
});
