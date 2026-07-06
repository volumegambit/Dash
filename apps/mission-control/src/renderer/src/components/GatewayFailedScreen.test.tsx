import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { GatewayFailedScreen } from './GatewayFailedScreen.js';

describe('GatewayFailedScreen', () => {
  it('renders the failure message', async () => {
    render(<GatewayFailedScreen onRecovered={() => {}} />);
    expect(
      await screen.findByRole('heading', { name: /Gateway failed to start/i }),
    ).toBeInTheDocument();
  });

  it('calls setupEnsureGateway on Retry and onRecovered on success', async () => {
    const user = userEvent.setup();
    const onRecovered = vi.fn();
    mockApi.setupEnsureGateway.mockResolvedValueOnce(undefined);
    render(<GatewayFailedScreen onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /Retry/i }));

    await waitFor(() => expect(mockApi.setupEnsureGateway).toHaveBeenCalledOnce());
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
  });

  it('shows the error and does not recover when retry fails', async () => {
    const user = userEvent.setup();
    const onRecovered = vi.fn();
    mockApi.setupEnsureGateway.mockRejectedValueOnce(new Error('boom'));
    render(<GatewayFailedScreen onRecovered={onRecovered} />);

    await user.click(screen.getByRole('button', { name: /Retry/i }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('calls appQuit when Quit clicked', async () => {
    const user = userEvent.setup();
    render(<GatewayFailedScreen onRecovered={() => {}} />);

    await user.click(screen.getByRole('button', { name: /Quit/i }));

    expect(mockApi.appQuit).toHaveBeenCalledOnce();
  });

  it('can switch back to this computer when a saved remote gateway fails', async () => {
    const user = userEvent.setup();
    const onRecovered = vi.fn();
    mockApi.gatewayConnectionGet.mockResolvedValue({
      profile: {
        mode: 'relay',
        name: 'prod',
        managementBaseUrl: 'https://gw.relay.example.com',
      },
      hasRemoteSecrets: true,
      health: 'unhealthy',
    });

    render(<GatewayFailedScreen onRecovered={onRecovered} />);

    expect(
      await screen.findByRole('heading', { name: /saved gateway is not reachable/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /use this computer/i }));

    await waitFor(() => expect(mockApi.gatewayConnectionUseLocal).toHaveBeenCalledOnce());
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it('opens the gateway editor from a saved remote gateway failure', async () => {
    const user = userEvent.setup();
    mockApi.gatewayConnectionGet.mockResolvedValue({
      profile: {
        mode: 'relay',
        name: 'prod',
        managementBaseUrl: 'https://gw.relay.example.com',
      },
      hasRemoteSecrets: true,
      health: 'unhealthy',
    });

    render(<GatewayFailedScreen onRecovered={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /edit gateway connection/i }));

    expect(screen.getByRole('heading', { name: /choose a gateway/i })).toBeInTheDocument();
  });
});
