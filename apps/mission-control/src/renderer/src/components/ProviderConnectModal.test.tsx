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

  it('pre-fills key name when keyName prop is provided', () => {
    render(
      <ProviderConnectModal provider="anthropic" keyName="default" onClose={noop} onSaved={noop} />,
    );
    const keyNameInput = screen.getByLabelText('Key name');
    expect(keyNameInput).toHaveValue('default');
  });

  it('calls credentialsSet with composite key and onSaved on submit', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <ProviderConnectModal
        provider="anthropic"
        keyName="default"
        onClose={noop}
        onSaved={onSaved}
      />,
    );
    await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-testkey');
    await user.click(screen.getByText('Save API Key'));
    expect(mockApi.credentialsSet).toHaveBeenCalledWith('anthropic-api-key:default', 'sk-ant-testkey');
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

  it('shows error when credentialsSet rejects', async () => {
    const user = userEvent.setup();
    mockApi.credentialsSet.mockRejectedValueOnce(new Error('Network error'));
    render(
      <ProviderConnectModal provider="google" keyName="default" onClose={noop} onSaved={noop} />,
    );
    await user.type(screen.getByPlaceholderText('AIza...'), 'AIzatest');
    await user.click(screen.getByText('Save API Key'));
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('shows error when key name contains invalid characters', async () => {
    const user = userEvent.setup();
    render(<ProviderConnectModal provider="anthropic" onClose={noop} onSaved={noop} />);
    const keyNameInput = screen.getByLabelText('Key name');
    await user.type(keyNameInput, 'bad name!');
    await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-testkey');
    await user.click(screen.getByText('Save API Key'));
    expect(
      await screen.findByText('Key name must contain only letters, numbers, and hyphens.'),
    ).toBeInTheDocument();
    expect(mockApi.credentialsSet).not.toHaveBeenCalled();
  });
});
