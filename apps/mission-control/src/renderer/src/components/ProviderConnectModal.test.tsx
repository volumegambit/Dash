import '@testing-library/jest-dom/vitest';
import type { RuntimePluginProvider } from '@dash/management';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { ProviderConnectModal } from './ProviderConnectModal.js';
import { providerConnectConfig } from './providers.js';

// A representative bundled provider carrying full ui hints — the modal is now
// always driven by a derived config, so tests build one from a runtime provider.
const anthropicProvider: RuntimePluginProvider = {
  id: 'anthropic',
  label: 'Anthropic',
  credentialPrefix: 'anthropic-api-key',
  pluginName: 'dash-core-providers',
  ui: {
    keyConsoleUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-...',
    docsUrl: 'https://docs.anthropic.com/en/docs/initial-setup',
    description: 'Claude models',
    sortOrder: 0,
  },
};

const googleProvider: RuntimePluginProvider = {
  id: 'google',
  label: 'Google Gemini',
  credentialPrefix: 'google-api-key',
  pluginName: 'dash-core-providers',
  ui: {
    keyConsoleUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIza...',
    sortOrder: 2,
  },
};

const openaiProvider: RuntimePluginProvider = {
  id: 'openai',
  label: 'OpenAI',
  credentialPrefix: 'openai-api-key',
  pluginName: 'dash-core-providers',
  ui: { keyConsoleUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-...' },
};

describe('ProviderConnectModal', () => {
  const noop = () => {};

  it('renders the provider title from the derived providerConfig', () => {
    render(
      <ProviderConnectModal
        provider="anthropic"
        providerConfig={providerConnectConfig(anthropicProvider)}
        onClose={noop}
        onSaved={noop}
      />,
    );
    expect(screen.getByText('Connect to Anthropic')).toBeInTheDocument();
  });

  it('renders the API keys URL as a clickable button', () => {
    render(
      <ProviderConnectModal
        provider="anthropic"
        providerConfig={providerConnectConfig(anthropicProvider)}
        onClose={noop}
        onSaved={noop}
      />,
    );
    // apiKeysUrl hint present -> the "API Keys" step link renders.
    expect(screen.getByText('API Keys')).toBeInTheDocument();
  });

  it('calls openExternal with apiKeysUrl when the API Keys link clicked', async () => {
    const user = userEvent.setup();
    render(
      <ProviderConnectModal
        provider="anthropic"
        providerConfig={providerConnectConfig(anthropicProvider)}
        onClose={noop}
        onSaved={noop}
      />,
    );
    await user.click(screen.getByText('API Keys'));
    expect(mockApi.openExternal).toHaveBeenCalledWith(
      'https://console.anthropic.com/settings/keys',
    );
  });

  it('pre-fills key name when keyName prop is provided', () => {
    render(
      <ProviderConnectModal
        provider="anthropic"
        providerConfig={providerConnectConfig(anthropicProvider)}
        keyName="default"
        onClose={noop}
        onSaved={noop}
      />,
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
        providerConfig={providerConnectConfig(anthropicProvider)}
        keyName="default"
        onClose={noop}
        onSaved={onSaved}
      />,
    );
    await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-testkey');
    await user.click(screen.getByText('Save API Key'));
    expect(mockApi.credentialsSet).toHaveBeenCalledWith(
      'anthropic-api-key:default',
      'sk-ant-testkey',
    );
    await screen.findByRole('button', { name: /save api key/i });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ProviderConnectModal
        provider="openai"
        providerConfig={providerConnectConfig(openaiProvider)}
        onClose={onClose}
        onSaved={noop}
      />,
    );
    await user.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows error when credentialsSet rejects', async () => {
    const user = userEvent.setup();
    mockApi.credentialsSet.mockRejectedValueOnce(new Error('Network error'));
    render(
      <ProviderConnectModal
        provider="google"
        providerConfig={providerConnectConfig(googleProvider)}
        keyName="default"
        onClose={noop}
        onSaved={noop}
      />,
    );
    await user.type(screen.getByPlaceholderText('AIza...'), 'AIzatest');
    await user.click(screen.getByText('Save API Key'));
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('shows error when key name contains invalid characters', async () => {
    const user = userEvent.setup();
    render(
      <ProviderConnectModal
        provider="anthropic"
        providerConfig={providerConnectConfig(anthropicProvider)}
        onClose={noop}
        onSaved={noop}
      />,
    );
    const keyNameInput = screen.getByLabelText('Key name');
    await user.type(keyNameInput, 'bad name!');
    await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-testkey');
    await user.click(screen.getByText('Save API Key'));
    expect(
      await screen.findByText('Key name must contain only letters, numbers, and hyphens.'),
    ).toBeInTheDocument();
    expect(mockApi.credentialsSet).not.toHaveBeenCalled();
  });

  // A provider without ui hints yields empty URL fields: the URL instruction
  // steps are omitted and the provider-specific steps renumber from 1.
  describe('with a hint-less provider config', () => {
    const plainProvider: RuntimePluginProvider = {
      id: 'myprov',
      label: 'My Provider',
      credentialPrefix: 'myprov-api-key',
      pluginName: 'llmpack',
    };

    it('renders the derived title and omits the API Keys URL step', () => {
      render(
        <ProviderConnectModal
          provider="myprov"
          providerConfig={providerConnectConfig(plainProvider)}
          keyName="default"
          onClose={noop}
          onSaved={noop}
        />,
      );
      expect(screen.getByText('Connect to My Provider')).toBeInTheDocument();
      expect(screen.queryByText('API Keys')).not.toBeInTheDocument();
    });

    it('saves the credential under {pluginId}-api-key:{keyName}', async () => {
      const user = userEvent.setup();
      const onSaved = vi.fn();
      render(
        <ProviderConnectModal
          provider="myprov"
          providerConfig={providerConnectConfig(plainProvider)}
          keyName="default"
          onClose={noop}
          onSaved={onSaved}
        />,
      );
      await user.type(screen.getByLabelText('API key'), 'secret-token');
      await user.click(screen.getByText('Save API Key'));
      expect(mockApi.credentialsSet).toHaveBeenCalledWith('myprov-api-key:default', 'secret-token');
      expect(onSaved).toHaveBeenCalledOnce();
    });
  });
});
