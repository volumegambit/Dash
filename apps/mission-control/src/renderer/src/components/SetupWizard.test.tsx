import '@testing-library/jest-dom/vitest';
import type { RuntimePluginProvider } from '@dash/management';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { SetupWizard } from './SetupWizard.js';

// The five bundled providers as the gateway reports them. The wizard fetches
// these once the gateway is up (post-consent). anthropic carries sortOrder 0,
// so it is selected by default.
const BUNDLED: RuntimePluginProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    credentialPrefix: 'anthropic-api-key',
    pluginName: 'dash-core-providers',
    ui: {
      description: 'Claude models',
      keyConsoleUrl: 'https://console.anthropic.com/settings/keys',
      keyPlaceholder: 'sk-ant-...',
      docsUrl: 'https://docs.anthropic.com/en/docs/initial-setup',
      sortOrder: 0,
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    credentialPrefix: 'openai-api-key',
    pluginName: 'dash-core-providers',
    ui: {
      description: 'GPT models',
      keyConsoleUrl: 'https://platform.openai.com/api-keys',
      keyPlaceholder: 'sk-...',
      sortOrder: 1,
    },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    credentialPrefix: 'google-api-key',
    pluginName: 'dash-core-providers',
    ui: {
      description: 'Gemini models',
      keyConsoleUrl: 'https://aistudio.google.com/app/apikey',
      keyPlaceholder: 'AIza...',
      sortOrder: 2,
    },
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

/**
 * Click through the keychain-consent step so the following assertions
 * start at the "setting-up" → "provider" transition. Used by tests
 * that care about the provider / api-key / done flow, not the consent
 * UI itself.
 */
async function clickThroughConsent(user: UserEvent): Promise<void> {
  // The consent step renders a Continue button. Clicking it transitions
  // to 'setting-up', which mounts SettingUpStep and fires setupEnsureGateway.
  await user.click(screen.getByRole('button', { name: /^Continue$/ }));
}

describe('SetupWizard', () => {
  const noop = () => {};

  beforeEach(() => {
    // Deliberately reverse the gateway order so the default-selection test
    // genuinely proves the wizard SORTS: anthropic (sortOrder 0) must still be
    // selected by default even though it arrives LAST from the gateway.
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [...BUNDLED].reverse(),
      plugins: [],
    });
  });

  describe('keychain-consent step (initial)', () => {
    it('is the initial step when needsSetup=true', () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      expect(screen.getByText('Welcome to Dash')).toBeInTheDocument();
      expect(screen.getByText(/secure credential store/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Continue$/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Cancel and quit/ })).toBeInTheDocument();
    });

    it('does NOT call setupEnsureGateway on mount', () => {
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      // The whole point of the consent step: keychain access (which
      // happens inside setupEnsureGateway) must not fire until the
      // user has acknowledged the consent modal.
      expect(mockApi.setupEnsureGateway).not.toHaveBeenCalled();
    });

    it('calls setupEnsureGateway only after user clicks Continue', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      expect(mockApi.setupEnsureGateway).not.toHaveBeenCalled();

      await clickThroughConsent(user);

      await waitFor(() => {
        expect(mockApi.setupEnsureGateway).toHaveBeenCalledOnce();
      });
    });

    it('calls appQuit when Cancel clicked', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await user.click(screen.getByRole('button', { name: /Cancel and quit/ }));

      expect(mockApi.appQuit).toHaveBeenCalledOnce();
    });
  });

  describe('setting-up step (post-consent)', () => {
    it('shows loading UI after Continue and advances to provider step on ready', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      // Loading UI is visible between clicking Continue and the mock
      // setupEnsureGateway resolving. On success we advance to the
      // provider step.
      await screen.findByText('Choose Your AI Provider');
    });

    it('shows gateway error if setupEnsureGateway rejects', async () => {
      const user = userEvent.setup();
      mockApi.setupEnsureGateway.mockRejectedValue(new Error('Gateway failed to start'));
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);

      await screen.findByText('Gateway Error');
      expect(screen.getByText('Gateway failed to start')).toBeInTheDocument();
    });
  });

  describe('done step (needsSetup=false)', () => {
    it('skips the wizard and lands directly on done', () => {
      render(<SetupWizard needsSetup={false} onComplete={noop} />);
      expect(screen.getByText("You're All Set!")).toBeInTheDocument();
      expect(screen.getByText('Get Started')).toBeInTheDocument();
      // Skipping to 'done' must NOT trigger setupEnsureGateway — the
      // caller already determined the gateway is live.
      expect(mockApi.setupEnsureGateway).not.toHaveBeenCalled();
    });

    it('calls onComplete when "Get Started" clicked', async () => {
      const user = userEvent.setup();
      const onComplete = vi.fn();
      render(<SetupWizard needsSetup={false} onComplete={onComplete} />);

      await user.click(screen.getByText('Get Started'));

      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  describe('provider step', () => {
    it('shows the gateway providers with Anthropic selected by default', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      // All five labels render.
      expect(await screen.findByText('Anthropic')).toBeInTheDocument();
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.getByText('Google Gemini')).toBeInTheDocument();
      expect(screen.getByText('Kimi (Moonshot)')).toBeInTheDocument();
      expect(screen.getByText('OpenRouter')).toBeInTheDocument();
      // Anthropic (sortOrder 0) is selected by default — even though the gateway
      // returned it LAST (fixture reversed), proving the wizard sorts. Default
      // selection lands via an effect, so await it.
      expect(await screen.findByText(/Continue with Anthropic/)).toBeInTheDocument();
    });

    it('shows an error with Retry when runtime() rejects, and Retry proceeds', async () => {
      const user = userEvent.setup();
      mockApi.plugins.runtime.mockRejectedValueOnce(new Error('gateway down'));
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      // Error surfaced with a Retry affordance.
      expect(await screen.findByText('gateway down')).toBeInTheDocument();
      const retry = screen.getByRole('button', { name: /Retry/i });
      // Next fetch resolves.
      mockApi.plugins.runtime.mockResolvedValue({ providers: BUNDLED, plugins: [] });
      await user.click(retry);
      expect(await screen.findByText(/Continue with Anthropic/)).toBeInTheDocument();
    });

    it('falls back to the first provider when the selected one vanishes on refetch', async () => {
      const user = userEvent.setup();
      const anthropicOnly = BUNDLED.filter((p) => p.id === 'anthropic');
      const anthropicPlusOpenai = BUNDLED.filter((p) => p.id === 'anthropic' || p.id === 'openai');
      // Initial provider-step fetch lists anthropic + openai.
      mockApi.plugins.runtime.mockResolvedValueOnce({
        providers: anthropicPlusOpenai,
        plugins: [],
      });
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText('OpenAI');

      // Select openai explicitly.
      await user.click(screen.getByText('OpenAI'));
      expect(await screen.findByText(/Continue with OpenAI/)).toBeInTheDocument();

      // Arrange the NEXT provider-step fetch to drop openai, then re-mount the
      // step by navigating to api-key and Back (that refetches on mount).
      mockApi.plugins.runtime.mockResolvedValue({ providers: anthropicOnly, plugins: [] });
      await user.click(screen.getByText(/Continue with OpenAI/));
      await screen.findByText('Connect to OpenAI');
      await user.click(screen.getByText('Back'));

      // openai is gone; selection falls back to the first sorted provider.
      expect(await screen.findByText(/Continue with Anthropic/)).toBeInTheDocument();
      expect(screen.queryByText(/Continue with OpenAI/)).not.toBeInTheDocument();
    });

    it('preserves the selection when the refetch still lists it', async () => {
      const user = userEvent.setup();
      const anthropicPlusOpenai = BUNDLED.filter((p) => p.id === 'anthropic' || p.id === 'openai');
      // Both fetches list anthropic + openai.
      mockApi.plugins.runtime.mockResolvedValue({
        providers: anthropicPlusOpenai,
        plugins: [],
      });
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText('OpenAI');

      await user.click(screen.getByText('OpenAI'));
      await screen.findByText(/Continue with OpenAI/);

      // Re-mount the step (refetch) — openai is still present, so it stays.
      await user.click(screen.getByText(/Continue with OpenAI/));
      await screen.findByText('Connect to OpenAI');
      await user.click(screen.getByText('Back'));

      expect(await screen.findByText(/Continue with OpenAI/)).toBeInTheDocument();
    });

    it('renders no OAuth CTA on the api-key step for a prototype-chain provider id', async () => {
      const user = userEvent.setup();
      // A provider whose id is a key on Object.prototype ('constructor'). A bare
      // OAUTH_LABEL[id] lookup would pull a truthy value and render the OAuth
      // button; Object.hasOwn must prevent that.
      mockApi.plugins.runtime.mockResolvedValue({
        providers: [
          {
            id: 'constructor',
            label: 'Proto Provider',
            credentialPrefix: 'constructor-api-key',
            pluginName: 'llmpack',
            ui: { description: 'proto', keyPlaceholder: 'key...', sortOrder: 0 },
          },
        ],
        plugins: [],
      });
      render(<SetupWizard needsSetup={true} onComplete={noop} />);
      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Proto Provider/);
      await user.click(screen.getByText(/Continue with Proto Provider/));
      expect(await screen.findByText('Connect to Proto Provider')).toBeInTheDocument();

      // The OAuth block must not render at all. Its "or use an API key" divider
      // is a stable marker — asserting on the button label alone would miss the
      // bug, since the leaked prototype value is a function (renders as empty
      // text) yet still gates the whole OAuth section into existence.
      expect(screen.queryByText('or use an API key')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();
      // The API-key input is still present.
      expect(screen.getByPlaceholderText('key...')).toBeInTheDocument();
    });
  });

  describe('api key step', () => {
    it('calls credentialsSet with anthropic-api-key:default on save', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Anthropic/);

      // Navigate from provider to api-key step
      await user.click(screen.getByText(/Continue with Anthropic/));
      expect(screen.getByText('Connect to Anthropic')).toBeInTheDocument();

      await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-key-123');
      await user.click(screen.getByText('Save API Key'));

      expect(mockApi.credentialsSet).toHaveBeenCalledWith(
        'anthropic-api-key:default',
        'sk-ant-test-key-123',
      );
      await screen.findByText("You're All Set!");
    });

    it('shows error message when credentialsSet rejects', async () => {
      const user = userEvent.setup();
      mockApi.credentialsSet.mockRejectedValue(new Error('Network error'));
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Anthropic/);
      await user.click(screen.getByText(/Continue with Anthropic/));
      await user.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-key-123');
      await user.click(screen.getByText('Save API Key'));

      await screen.findByText('Network error');
    });

    it('navigates back from api-key to provider', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Anthropic/);
      await user.click(screen.getByText(/Continue with Anthropic/));
      expect(screen.getByText('Connect to Anthropic')).toBeInTheDocument();

      await user.click(screen.getByText('Back'));
      expect(screen.getByText('Choose Your AI Provider')).toBeInTheDocument();
    });

    it('calls openExternal with the API keys URL when the API Keys link clicked', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Anthropic/);
      await user.click(screen.getByText(/Continue with Anthropic/));

      await user.click(screen.getByText('API Keys'));

      expect(mockApi.openExternal).toHaveBeenCalledWith(
        'https://console.anthropic.com/settings/keys',
      );
    });
  });

  describe('api key step — OAuth', () => {
    it('shows Claude OAuth button and opens code-entry view on click', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Anthropic/);
      await user.click(screen.getByText(/Continue with Anthropic/));

      // The OAuth CTA is visible above the API-key instructions
      const oauthBtn = screen.getByRole('button', { name: /Sign in with Claude/ });
      await user.click(oauthBtn);

      expect(mockApi.claudePrepareOAuth).toHaveBeenCalledOnce();
      await screen.findByText('Finish Claude login');
      expect(screen.getByLabelText('Authorization code')).toBeInTheDocument();
    });

    it('calls claudeCompleteOAuth with default label and advances to done on success', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Anthropic/);
      await user.click(screen.getByText(/Continue with Anthropic/));
      await user.click(screen.getByRole('button', { name: /Sign in with Claude/ }));

      await screen.findByText('Finish Claude login');
      await user.type(screen.getByLabelText('Authorization code'), 'auth-code-xyz');
      await user.click(screen.getByRole('button', { name: /Verify and continue/ }));

      expect(mockApi.claudeCompleteOAuth).toHaveBeenCalledWith(
        'default',
        'auth-code-xyz',
        's', // state from mockApi.claudePrepareOAuth
        'v', // verifier from mockApi.claudePrepareOAuth
      );
      await screen.findByText("You're All Set!");
    });

    it('surfaces Claude OAuth error from completeOAuth result', async () => {
      const user = userEvent.setup();
      mockApi.claudeCompleteOAuth.mockResolvedValue({ success: false, error: 'Invalid code' });
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText(/Continue with Anthropic/);
      await user.click(screen.getByText(/Continue with Anthropic/));
      await user.click(screen.getByRole('button', { name: /Sign in with Claude/ }));
      await screen.findByText('Finish Claude login');
      await user.type(screen.getByLabelText('Authorization code'), 'bad-code');
      await user.click(screen.getByRole('button', { name: /Verify and continue/ }));

      await screen.findByText('Invalid code');
      // User stays on the code-entry view so they can retry.
      expect(screen.getByText('Finish Claude login')).toBeInTheDocument();
    });

    it('calls codexStartOAuth when OpenAI is selected and Sign in clicked', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText('OpenAI');
      await user.click(screen.getByText('OpenAI'));
      await user.click(screen.getByText(/Continue with OpenAI/));
      expect(screen.getByText('Connect to OpenAI')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }));

      expect(mockApi.codexStartOAuth).toHaveBeenCalledWith('default');
      await screen.findByText("You're All Set!");
    });

    it('does NOT show an OAuth button for Google', async () => {
      const user = userEvent.setup();
      render(<SetupWizard needsSetup={true} onComplete={noop} />);

      await clickThroughConsent(user);
      await screen.findByText('Choose Your AI Provider');
      await screen.findByText('Google Gemini');
      await user.click(screen.getByText('Google Gemini'));
      await user.click(screen.getByText(/Continue with Google Gemini/));
      expect(screen.getByText('Connect to Google Gemini')).toBeInTheDocument();

      expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();
      // The API key input is still present.
      expect(screen.getByPlaceholderText('AIza...')).toBeInTheDocument();
    });
  });
});
