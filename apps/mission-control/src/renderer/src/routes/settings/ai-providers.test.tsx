import '@testing-library/jest-dom/vitest';
import type { RuntimePluginProvider } from '@dash/management';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../../vitest.setup.js';
import { AiProviders } from './ai-providers.js';

// The five bundled providers as the gateway reports them (pluginName
// dash-core-providers, ui hints incl. sortOrder), plus one third-party
// provider from plugin 'llmpack'.
const BUNDLED: RuntimePluginProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    credentialPrefix: 'anthropic-api-key',
    pluginName: 'dash-core-providers',
    ui: { description: 'Claude models', keyPlaceholder: 'sk-ant-...', sortOrder: 0 },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    credentialPrefix: 'openai-api-key',
    pluginName: 'dash-core-providers',
    ui: { description: 'GPT models', keyPlaceholder: 'sk-...', sortOrder: 1 },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    credentialPrefix: 'google-api-key',
    pluginName: 'dash-core-providers',
    ui: { description: 'Gemini models', keyPlaceholder: 'AIza...', sortOrder: 2 },
  },
  {
    id: 'moonshotai',
    label: 'Kimi (Moonshot)',
    credentialPrefix: 'moonshotai-api-key',
    pluginName: 'dash-core-providers',
    ui: { description: 'Kimi K2 models', keyPlaceholder: 'sk-...', sortOrder: 3 },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    credentialPrefix: 'openrouter-api-key',
    pluginName: 'dash-core-providers',
    ui: { description: 'Many models, one key', keyPlaceholder: 'sk-or-v1-...', sortOrder: 4 },
  },
];

const PLUGIN_PROVIDER: RuntimePluginProvider = {
  id: 'myllm',
  label: 'My LLM',
  credentialPrefix: 'myllm-api-key',
  pluginName: 'llmpack',
  ui: { description: 'A plugin-contributed provider', sortOrder: 10 },
};

function mockRuntime(providers: RuntimePluginProvider[]): void {
  mockApi.plugins.runtime.mockResolvedValue({ providers, plugins: [] });
}

describe('AiProviders page', () => {
  beforeEach(() => {
    mockApi.credentialsList.mockResolvedValue(['anthropic-api-key:default']);
    // Deliberately shuffle (reverse) the gateway order so the test proves the
    // page SORTS rather than passing through arrival order. If sortProviders
    // is removed, the rendered order would match this reversed input and the
    // DOM-order assertion below fails.
    mockRuntime([...BUNDLED, PLUGIN_PROVIDER].reverse());
  });

  it('renders one card per gateway provider in sortOrder order', async () => {
    render(<AiProviders />);
    await screen.findByText('Anthropic');
    const expected = [
      'Anthropic',
      'OpenAI',
      'Google Gemini',
      'Kimi (Moonshot)',
      'OpenRouter',
      'My LLM',
    ];
    // Assert the ACTUAL rendered order, not mere presence — this is what guards
    // sortProviders. Each provider label is rendered as the card's
    // `font-semibold` <p>; reading them in document order gives the display
    // sequence, which must be sorted regardless of the reversed gateway input.
    await waitFor(() => {
      expect(screen.getAllByText('Add Key')).toHaveLength(6);
    });
    const rendered = Array.from(document.querySelectorAll('p.font-semibold.text-foreground')).map(
      (el) => el.textContent,
    );
    expect(rendered).toEqual(expected);
  });

  it('badges only the non-bundled provider with its plugin name', async () => {
    render(<AiProviders />);
    await screen.findByText('My LLM');
    // Third-party provider is badged with its plugin name.
    expect(screen.getByText('llmpack')).toBeInTheDocument();
    // Bundled providers are not badged with the bundled plugin name.
    expect(screen.queryByText('dash-core-providers')).not.toBeInTheDocument();
  });

  it('renders the provider ui.description as a subtitle', async () => {
    render(<AiProviders />);
    await screen.findByText('A plugin-contributed provider');
    expect(screen.getByText('Claude models')).toBeInTheDocument();
  });

  it('shows connected status indicator for providers with a key', async () => {
    render(<AiProviders />);
    expect(await screen.findByText('Anthropic')).toBeInTheDocument();
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('shows an OAuth login button only for anthropic and openai', async () => {
    render(<AiProviders />);
    await screen.findByText('Anthropic');
    await waitFor(() => {
      expect(screen.getAllByText(/Login Key$/)).toHaveLength(2);
    });
  });

  it('opens the modal with the derived title when Add Key clicked for the plugin provider', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await screen.findByText('My LLM');
    const addButton = await screen.findByRole('button', { name: /Add key for My LLM/i });
    await user.click(addButton);
    expect(await screen.findByText('Connect to My LLM')).toBeInTheDocument();
  });

  it('saves a plugin credential under {pluginId}-api-key:{keyName}', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await screen.findByText('My LLM');
    const addButton = await screen.findByRole('button', { name: /Add key for My LLM/i });
    await user.click(addButton);
    await screen.findByText('Connect to My LLM');
    await user.type(screen.getByLabelText('API key'), 'plugin-secret');
    await user.click(screen.getByText('Save API Key'));
    expect(mockApi.credentialsSet).toHaveBeenCalledWith('myllm-api-key:default', 'plugin-secret');
  });

  it('groups keys per id loaded from credentialsList', async () => {
    mockApi.credentialsList.mockResolvedValue([
      'anthropic-api-key:default',
      'myllm-api-key:default',
    ]);
    render(<AiProviders />);
    await screen.findByText('My LLM');
    const defaults = await screen.findAllByText('default');
    expect(defaults.length).toBeGreaterThanOrEqual(2);
  });

  it('opens modal when Add Key is clicked for unconnected provider', async () => {
    const user = userEvent.setup();
    render(<AiProviders />);
    await screen.findByText('OpenAI');
    await waitFor(() => screen.getAllByText('Add Key'));
    await user.click(screen.getAllByText('Add Key')[1]);
    expect(await screen.findByText('Connect to OpenAI')).toBeInTheDocument();
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

  it('calls credentialsRemove with the composite key and oauth-slot cleanup when disconnect confirmed', async () => {
    const user = userEvent.setup();
    mockApi.credentialsRemove.mockResolvedValue(undefined);
    render(<AiProviders />);
    await waitFor(() => screen.getByText('Remove'));
    await user.click(screen.getByText('Remove'));
    await user.click(screen.getByText('Yes, remove'));
    expect(mockApi.credentialsRemove).toHaveBeenCalledWith('anthropic-api-key:default');
    expect(mockApi.credentialsRemove).toHaveBeenCalledWith('anthropic-oauth-refresh:default');
    expect(mockApi.credentialsRemove).toHaveBeenCalledWith('anthropic-oauth-expires:default');
  });

  it('pre-fills key name as default when provider has no keys', async () => {
    const user = userEvent.setup();
    mockApi.credentialsList.mockResolvedValue([]);
    render(<AiProviders />);
    await screen.findByText('Anthropic');
    await waitFor(() => screen.getAllByText('Add Key'));
    await user.click(screen.getAllByText('Add Key')[0]);
    const keyNameInput = screen.getByLabelText('Key name');
    expect(keyNameInput).toHaveValue('default');
  });

  it('keeps the latest keys when an earlier credentialsList response resolves last', async () => {
    // Single-provider fixture so the status ("Active"/"Disabled") is
    // unambiguous — the invariant is purely "anthropic's key survives".
    mockRuntime([BUNDLED[0]]);
    // loadKeys fires twice on mount (providers empty → providers arrive). The
    // FIRST call sees no providers so it would group {} ; the SECOND call sees
    // providers and finds the key. If the first response resolves LAST it must
    // NOT clobber the second. Force that ordering with two deferred promises.
    let resolveFirst: (v: string[]) => void = () => {};
    let resolveSecond: (v: string[]) => void = () => {};
    const first = new Promise<string[]>((r) => {
      resolveFirst = r;
    });
    const second = new Promise<string[]>((r) => {
      resolveSecond = r;
    });
    mockApi.credentialsList.mockReturnValueOnce(first).mockReturnValueOnce(second);

    render(<AiProviders />);
    // Resolve the SECOND call first: it carries the real key.
    resolveSecond(['anthropic-api-key:default']);
    await screen.findByText('Active');
    // Now resolve the earlier (stale) call with an empty list. The guard must
    // drop it so the displayed key survives.
    resolveFirst([]);
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    // Without the stale-response guard, the late {} would flip anthropic to
    // "Disabled" — assert it did NOT.
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
  });

  it('renders no OAuth UI for a provider whose id is a prototype-chain key', async () => {
    // A gateway provider id like 'constructor' is kebab-valid but also a key on
    // Object.prototype. A bare `id in OAUTH_CONFIG` / `OAUTH_LABEL[id]` lookup
    // would treat it as OAuth-capable and render a login button. Object.hasOwn
    // must prevent that.
    mockApi.credentialsList.mockResolvedValue([]);
    mockRuntime([
      {
        id: 'constructor',
        label: 'Proto Provider',
        credentialPrefix: 'constructor-api-key',
        pluginName: 'llmpack',
        ui: { description: 'proto', sortOrder: 0 },
      },
    ]);
    render(<AiProviders />);
    await screen.findByText('Proto Provider');
    // The OAuth button is uniquely styled with `border-green-700`. Asserting on
    // that class (not the label) catches the bug even though the leaked
    // prototype value is a function whose `.label` is undefined — so the button
    // would render with EMPTY text yet still exist in the DOM.
    expect(document.querySelector('button.border-green-700')).toBeNull();
    // The normal Add Key affordance is still present.
    expect(screen.getByText('Add Key')).toBeInTheDocument();
  });
});

describe('AiProviders page — non-happy states', () => {
  beforeEach(() => {
    mockApi.credentialsList.mockResolvedValue([]);
  });

  it('renders the error card with Retry when runtime() rejects, and Retry refetches', async () => {
    const user = userEvent.setup();
    mockApi.plugins.runtime.mockRejectedValueOnce(new Error('gateway down'));
    render(<AiProviders />);
    expect(await screen.findByText('gateway down')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });

    // Next fetch resolves with providers.
    mockRuntime(BUNDLED);
    await user.click(retry);
    expect(await screen.findByText('Anthropic')).toBeInTheDocument();
  });

  it('renders the no-providers card naming dash-core-providers when providers is empty', async () => {
    mockRuntime([]);
    render(<AiProviders />);
    expect(await screen.findByText('No AI providers available')).toBeInTheDocument();
    expect(screen.getByText(/dash-core-providers/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });
});
