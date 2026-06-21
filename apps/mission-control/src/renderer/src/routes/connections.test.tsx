import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { AiProviders } from './connections.js';

describe('AiProviders page', () => {
  beforeEach(() => {
    // Default: anthropic has one key, others have none
    mockApi.credentialsList.mockResolvedValue(['anthropic-api-key:default']);
  });

  it('shows connected status indicator for providers with a key', async () => {
    render(<AiProviders />);
    expect(await screen.findByText('Claude by Anthropic')).toBeInTheDocument();
    // Key entries load asynchronously from credentialsList
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('shows Add Key button for every provider', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      const addButtons = screen.getAllByText('Add Key');
      // one per provider (anthropic, openai, google, moonshotai, openrouter)
      expect(addButtons).toHaveLength(5);
    });
  });

  it('surfaces Moonshot as an API-key-only provider (label shown, no OAuth login button)', async () => {
    render(<AiProviders />);
    expect(await screen.findByText('Kimi by Moonshot')).toBeInTheDocument();
    // Only Anthropic + OpenAI expose an OAuth "...Login Key" button; Moonshot,
    // Google, and OpenRouter are API-key only, so the count must stay at 2.
    await waitFor(() => {
      expect(screen.getAllByText(/Login Key$/)).toHaveLength(2);
    });
  });

  it('opens modal when Add Key is clicked for unconnected provider', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await waitFor(() => screen.getAllByText('Add Key'));
    await user.click(screen.getAllByText('Add Key')[1]);
    expect(screen.getByText('Connect to OpenAI')).toBeInTheDocument();
  });

  it('shows Update and Remove buttons for connected provider key', async () => {
    render(<AiProviders />);
    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
      expect(screen.getByText('Remove')).toBeInTheDocument();
    });
  });

  it('shows inline confirm when Remove is clicked', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Remove'));
    await user.click(screen.getByText('Remove'));
    expect(screen.getByText('Remove key?')).toBeInTheDocument();
    expect(screen.getByText('Yes, remove')).toBeInTheDocument();
  });

  it('calls credentialsRemove and refreshes when disconnect confirmed', async () => {
    const user = userEvent.setup();
    mockApi.credentialsRemove.mockResolvedValue(undefined);
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Remove'));
    await user.click(screen.getByText('Remove'));
    await user.click(screen.getByText('Yes, remove'));
    expect(mockApi.credentialsRemove).toHaveBeenCalledWith('anthropic-api-key:default');
  });

  it('pre-fills key name as default when provider has no keys', async () => {
    const user = userEvent.setup();
    mockApi.credentialsList.mockResolvedValue([]);
    render(<AiProviders />);
    await waitFor(() => screen.getAllByText('Add Key'));
    await user.click(screen.getAllByText('Add Key')[0]);
    const keyNameInput = screen.getByLabelText('Key name');
    expect(keyNameInput).toHaveValue('default');
  });
});

describe('AiProviders page — plugin providers', () => {
  beforeEach(() => {
    mockApi.credentialsList.mockResolvedValue(['anthropic-api-key:default']);
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [{ id: 'myprov', label: 'My Provider', credentialPrefix: 'myprov-api-key' }],
      plugins: [],
    });
  });

  it('renders both a core provider and a plugin provider', async () => {
    render(<AiProviders />);
    // Core provider still rendered.
    expect(await screen.findByText('Claude by Anthropic')).toBeInTheDocument();
    // Plugin provider rendered alongside core.
    expect(await screen.findByText('My Provider')).toBeInTheDocument();
  });

  it('shows existing plugin keys loaded from credentialsList', async () => {
    mockApi.credentialsList.mockResolvedValue([
      'anthropic-api-key:default',
      'myprov-api-key:default',
    ]);
    render(<AiProviders />);
    await screen.findByText('My Provider');
    // The plugin key name appears in the key entry list (alongside the core one).
    const defaults = await screen.findAllByText('default');
    expect(defaults.length).toBeGreaterThanOrEqual(2);
  });

  it('saves a plugin credential under {pluginId}-api-key:{keyName}', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await screen.findByText('My Provider');
    // Open the plugin provider's connect modal.
    const addButton = await screen.findByRole('button', { name: /Add key for My Provider/i });
    await user.click(addButton);
    // Synthesized config title.
    expect(await screen.findByText('Connect to My Provider')).toBeInTheDocument();
    await user.type(screen.getByLabelText('API key'), 'plugin-secret');
    await user.click(screen.getByText('Save API Key'));
    expect(mockApi.credentialsSet).toHaveBeenCalledWith('myprov-api-key:default', 'plugin-secret');
  });

  it('still renders core providers when plugin runtime errors (graceful)', async () => {
    mockApi.plugins.runtime.mockRejectedValue(new Error('gateway down'));
    render(<AiProviders />);
    // Core providers must still render despite the plugin-runtime failure.
    expect(await screen.findByText('Claude by Anthropic')).toBeInTheDocument();
    expect(await screen.findByText('Kimi by Moonshot')).toBeInTheDocument();
    // No plugin provider shown.
    expect(screen.queryByText('My Provider')).not.toBeInTheDocument();
  });
});
