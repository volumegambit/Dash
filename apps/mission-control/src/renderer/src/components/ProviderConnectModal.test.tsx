import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { ProviderConnectModal } from './ProviderConnectModal.js';

describe('ProviderConnectModal', () => {
  const noop = () => {};

  it('renders the provider title from PROVIDER_CONFIG', () => {
    render(<ProviderConnectModal provider="anthropic" onClose={noop} onSaved={noop} />);
    expect(screen.getByText('Connect to Claude')).toBeInTheDocument();
  });

  it('renders the console URL as a clickable button', () => {
    render(<ProviderConnectModal provider="anthropic" onClose={noop} onSaved={noop} />);
    expect(screen.getByText('console.anthropic.com')).toBeInTheDocument();
  });

  it('calls openExternal with consoleUrl when console link clicked', async () => {
    const user = userEvent.setup();
    render(<ProviderConnectModal provider="anthropic" onClose={noop} onSaved={noop} />);
    await user.click(screen.getByText('console.anthropic.com'));
    expect(mockApi.openExternal).toHaveBeenCalledWith('https://console.anthropic.com');
  });

  it('calls secretsSet and onSaved on submit', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<ProviderConnectModal provider="anthropic" onClose={noop} onSaved={onSaved} />);
    await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-testkey');
    await user.click(screen.getByText('Save API Key'));
    expect(mockApi.secretsSet).toHaveBeenCalledWith('anthropic-api-key', 'sk-ant-testkey');
    await screen.findByRole('button', { name: /save api key/i });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProviderConnectModal provider="openai" onClose={onClose} onSaved={noop} />);
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows error when secretsSet rejects', async () => {
    const user = userEvent.setup();
    mockApi.secretsSet.mockRejectedValueOnce(new Error('Network error'));
    render(<ProviderConnectModal provider="google" onClose={noop} onSaved={noop} />);
    await user.type(screen.getByPlaceholderText('AIza...'), 'AIzatest');
    await user.click(screen.getByText('Save API Key'));
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });
});
