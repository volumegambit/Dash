import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { GatewayFailedScreen } from './GatewayFailedScreen.js';

describe('GatewayFailedScreen', () => {
  it('renders the failure message', () => {
    render(<GatewayFailedScreen onRecovered={() => {}} />);
    expect(screen.getByText(/Gateway failed to start/i)).toBeInTheDocument();
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
});
