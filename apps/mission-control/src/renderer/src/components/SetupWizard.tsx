import type { RuntimePluginProvider } from '@dash/management';
import {
  ArrowRight,
  Bot,
  CheckCircle,
  ExternalLink,
  KeyRound,
  Loader,
  Lock,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useRuntimeProviders } from '../hooks/useRuntimeProviders.js';
import { DashSquadMark } from './DashSquadLogo.js';
import { providerConnectConfig, sortProviders } from './providers.js';

type Step = 'keychain-consent' | 'setting-up' | 'provider' | 'api-key' | 'done';

interface SetupWizardProps {
  needsSetup: boolean;
  onComplete: () => void;
}

export function SetupWizard({ needsSetup, onComplete }: SetupWizardProps): JSX.Element {
  // First-time users land on the keychain-consent step so they see a
  // Dash-branded explanation BEFORE the OS surfaces its native
  // keychain access prompt. Users with setup already complete skip
  // straight to 'done'.
  const initialStep: Step = needsSetup ? 'keychain-consent' : 'done';
  const [step, setStep] = useState<Step>(initialStep);
  // The selected provider is a full gateway provider object (not an id), so the
  // key step can derive its connect config directly.
  const [provider, setProvider] = useState<RuntimePluginProvider | null>(null);

  return (
    // `h-screen`, not `h-full`: this renders straight from the route with no
    // sized ancestor, so `h-full` collapsed to content height and the
    // `items-center` did nothing — the card sat at the top of the window with
    // roughly half of it empty below (captured via the renderer harness,
    // 2026-09-05). The loading state beside it in `__root.tsx` already uses
    // `h-screen`; this matches it.
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md px-4">
        {step === 'keychain-consent' && (
          <KeychainConsentStep
            onContinue={() => setStep('setting-up')}
            onCancel={() => {
              window.api.appQuit().catch(() => {
                // If the IPC call fails we can't force-quit from the
                // renderer; leave the user on the same screen.
              });
            }}
          />
        )}
        {step === 'setting-up' && (
          <SettingUpStep onReady={() => setStep('provider')} onSkip={onComplete} />
        )}
        {step === 'provider' && (
          <ProviderStep
            selected={provider}
            onSelect={setProvider}
            onNext={() => setStep('api-key')}
          />
        )}
        {step === 'api-key' && provider && (
          <ApiKeyStep
            provider={provider}
            onBack={() => setStep('provider')}
            onDone={() => setStep('done')}
          />
        )}
        {step === 'done' && <DoneStep onFinish={onComplete} />}
      </div>
    </div>
  );
}

function KeychainConsentStep({
  onContinue,
  onCancel,
}: {
  onContinue: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="text-center">
      <div className="mb-6 flex justify-center">
        <DashSquadMark size={48} />
      </div>
      <div className="mx-auto mb-4 inline-flex size-12 items-center justify-center rounded-full bg-accent-tint text-accent">
        <Lock size={24} />
      </div>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight">
        Welcome to Dash
      </h1>
      <p className="mt-3 text-sm text-muted">
        Dash stores its gateway access tokens in your system's secure credential store (macOS
        Keychain, Windows Credential Manager, or libsecret on Linux), so they're encrypted at rest
        and gated by your login session.
      </p>
      <p className="mt-3 text-sm text-muted">
        In a moment, your system will ask you to allow Dash to access these credentials. You only
        need to approve this once.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Continue
        <ArrowRight size={16} />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-border px-6 py-3 text-sm font-medium text-muted transition-colors hover:text-foreground"
      >
        Cancel and quit
      </button>
    </div>
  );
}

function SettingUpStep({
  onReady,
  onSkip,
}: {
  onReady: () => void;
  onSkip: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .setupEnsureGateway()
      .then(() => {
        onReady();
      })
      .catch((err: Error) => {
        setError(err.message);
      });
  }, [onReady]);

  if (error) {
    return (
      <div className="text-center">
        <div className="mb-6 flex justify-center">
          <DashSquadMark size={48} />
        </div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight">
          Gateway Error
        </h1>
        <p className="mt-3 text-sm text-red">{error}</p>
        <button
          type="button"
          onClick={onSkip}
          className="mt-8 inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        >
          Continue Anyway
          <ArrowRight size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="mb-6 flex justify-center">
        <DashSquadMark size={48} />
      </div>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight">
        Welcome to DashSquad
      </h1>
      <p className="mt-3 text-muted">Setting up your gateway&hellip;</p>
      <div className="mt-8 flex justify-center">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    </div>
  );
}

function ProviderStep({
  selected,
  onSelect,
  onNext,
}: {
  selected: RuntimePluginProvider | null;
  onSelect: (p: RuntimePluginProvider) => void;
  onNext: () => void;
}): JSX.Element {
  // The gateway is up by the time we reach this step (post 'setting-up'), so
  // the provider list comes straight from it.
  const { providers: runtimeProviders, loading, error, refetch } = useRuntimeProviders();
  const providers = useMemo(() => sortProviders(runtimeProviders), [runtimeProviders]);

  // Keep the selection valid against the current list:
  // - default-select the first sorted provider when nothing is selected yet
  //   (sortOrder 0 keeps anthropic first);
  // - if a selection exists but its id is no longer in the list (e.g. a refetch
  //   after Back-navigation dropped it), fall back to the first provider so the
  //   wizard never offers a vanished provider. A still-present selection is
  //   preserved untouched.
  useEffect(() => {
    if (providers.length === 0) return;
    if (!selected) {
      onSelect(providers[0]);
      return;
    }
    if (!providers.some((p) => p.id === selected.id)) {
      onSelect(providers[0]);
    }
  }, [selected, providers, onSelect]);

  return (
    <div>
      <div className="text-center">
        <Bot size={36} className="mx-auto mb-4 text-muted" />
        <h1 className="text-2xl font-bold">Choose Your AI Provider</h1>
        <p className="mt-2 text-sm text-muted">
          Your agents need an AI model to think and respond. Choose one provider to get started
          &mdash; you only need one, but you can add more later in Settings.
        </p>

        {loading && providers.length === 0 && (
          <div className="mt-8 flex justify-center">
            <Loader size={24} className="animate-spin text-muted" />
          </div>
        )}

        {!loading && providers.length === 0 && (
          <div className="mt-6 rounded-lg border border-border bg-card-bg p-6 text-left">
            <p className="text-sm text-muted">
              {error
                ? error.message
                : 'The gateway reported no provider catalogs. Make sure the built-in dash-core-providers plugin is enabled.'}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors"
            >
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        )}

        {providers.length > 0 && (
          <div className="mt-6 space-y-3 text-left">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p)}
                className={`w-full rounded-lg border-2 px-4 py-4 text-left transition-colors ${
                  selected?.id === p.id
                    ? 'border-accent bg-accent-tint'
                    : 'border-border bg-card-bg hover:border-muted'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">{p.label}</span>
                  {selected?.id === p.id && <CheckCircle size={18} className="text-accent" />}
                </div>
                {p.ui?.description && <p className="mt-1 text-xs text-muted">{p.ui.description}</p>}
              </button>
            ))}
          </div>
        )}

        {providers.length > 0 && (
          <button
            type="button"
            onClick={onNext}
            disabled={!selected}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            Continue with {selected?.label ?? 'selected provider'}
            <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

const OAUTH_LABEL: Record<string, string> = {
  anthropic: 'Sign in with Claude (Pro/Max)',
  openai: 'Sign in with ChatGPT (Codex)',
};

function ApiKeyStep({
  provider,
  onBack,
  onDone,
}: {
  provider: RuntimePluginProvider;
  onBack: () => void;
  onDone: () => void;
}): JSX.Element {
  const config = providerConnectConfig(provider);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Object.hasOwn (not a bare index) so a provider id like 'constructor' can't
  // walk the prototype chain and pull a truthy value off Object.prototype,
  // which would spuriously render the OAuth CTA on a non-OAuth provider.
  const oauthLabel = Object.hasOwn(OAUTH_LABEL, provider.id) ? OAUTH_LABEL[provider.id] : undefined;
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [claudeFlow, setClaudeFlow] = useState<{ state: string; verifier: string } | null>(null);
  const [claudeCode, setClaudeCode] = useState('');

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) return;

    setSaving(true);
    setError(null);
    try {
      await window.api.credentialsSet(config.secretKey, trimmed);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const handleClaudeOAuthStart = async (): Promise<void> => {
    setOauthError(null);
    setOauthLoading(true);
    try {
      const { state, verifier } = await window.api.claudePrepareOAuth();
      setClaudeFlow({ state, verifier });
      setClaudeCode('');
    } catch (err) {
      setOauthError((err as Error).message);
    } finally {
      setOauthLoading(false);
    }
  };

  const handleClaudeOAuthSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!claudeFlow) return;
    const code = claudeCode.trim();
    if (!code) return;
    setOauthLoading(true);
    setOauthError(null);
    try {
      const result = await window.api.claudeCompleteOAuth(
        'default',
        code,
        claudeFlow.state,
        claudeFlow.verifier,
      );
      if (result.success) {
        onDone();
      } else {
        setOauthError(result.error ?? 'Login failed');
      }
    } catch (err) {
      setOauthError((err as Error).message);
    } finally {
      setOauthLoading(false);
    }
  };

  const handleCodexOAuth = async (): Promise<void> => {
    setOauthError(null);
    setOauthLoading(true);
    try {
      const result = await window.api.codexStartOAuth('default');
      if (result.success) {
        onDone();
      } else {
        setOauthError(result.error ?? 'Login failed');
      }
    } catch (err) {
      setOauthError((err as Error).message);
    } finally {
      setOauthLoading(false);
    }
  };

  const handleOpenUrl = async (url: string): Promise<void> => {
    try {
      await window.api.openExternal(url);
    } catch {
      // Fallback: open via window.open if IPC fails
      window.open(url, '_blank');
    }
  };

  const consoleDomain = config.consoleUrl.replace(/^https?:\/\//, '');
  // How many leading URL-based steps render (console + API keys). Providers
  // without those URLs omit the steps, so provider-specific steps renumber.
  const urlStepCount = (config.consoleUrl ? 1 : 0) + (config.apiKeysUrl ? 1 : 0);

  if (claudeFlow) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setClaudeFlow(null);
            setClaudeCode('');
            setOauthError(null);
          }}
          className="mb-6 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
        >
          Back
        </button>
        <div className="text-center">
          <LogIn size={36} className="mx-auto mb-4 text-muted" />
          <h1 className="text-2xl font-bold">Finish Claude login</h1>
          <p className="mt-2 text-sm text-muted">
            A browser window opened. Sign in to your Claude account, then paste the authorization
            code below.
          </p>
          <form onSubmit={handleClaudeOAuthSubmit} className="mt-5 space-y-4 text-left">
            <input
              type="text"
              value={claudeCode}
              onChange={(e) => setClaudeCode(e.target.value)}
              placeholder="Paste authorization code"
              className="w-full rounded-lg border border-border bg-card-bg px-4 py-2 text-sm font-mono text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              aria-label="Authorization code"
            />
            {oauthError && <p className="text-sm text-red">{oauthError}</p>}
            <button
              type="submit"
              disabled={oauthLoading || !claudeCode.trim()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {oauthLoading && <Loader size={14} className="animate-spin" />}
              {oauthLoading ? 'Verifying...' : 'Verify and continue'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        Back
      </button>
      <div className="text-center">
        <KeyRound size={36} className="mx-auto mb-4 text-muted" />
        <h1 className="text-2xl font-bold">{config.title}</h1>
        <p className="mt-2 text-sm text-muted">{config.explanation}</p>

        {oauthLabel && (
          <div className="mt-5 space-y-3 text-left">
            <button
              type="button"
              onClick={provider.id === 'anthropic' ? handleClaudeOAuthStart : handleCodexOAuth}
              disabled={oauthLoading || saving}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-accent bg-accent-tint px-4 py-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
            >
              {oauthLoading ? <Loader size={16} className="animate-spin" /> : <LogIn size={16} />}
              {oauthLoading
                ? provider.id === 'openai'
                  ? 'Waiting for browser sign-in…'
                  : 'Opening browser…'
                : oauthLabel}
            </button>
            <p className="text-center text-[11px] text-muted">
              {provider.id === 'anthropic'
                ? 'Use your Claude Pro or Max subscription — no API key required.'
                : 'Use your ChatGPT Plus or Pro subscription — no API key required.'}
            </p>
            {oauthError && (
              <p className="rounded border border-red-900/50 bg-red-900/20 px-3 py-2 text-center text-xs text-red">
                {oauthError}
              </p>
            )}
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-muted">
                or use an API key
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}

        <div className="mt-4 rounded-lg border border-border bg-card-bg p-4 text-left">
          <p className="mb-3 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-muted">
            How to get your key
          </p>
          <ol className="space-y-2">
            {/* URL-based steps only render when the provider supplies the URLs.
                Providers without them start at the provider-specific steps. */}
            {config.consoleUrl && (
              <li className="flex gap-2 text-xs text-muted">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-bold text-accent">
                  1
                </span>
                <span className="pt-0.5">
                  Go to{' '}
                  <button
                    type="button"
                    onClick={() => handleOpenUrl(config.consoleUrl)}
                    className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline"
                  >
                    {consoleDomain}
                    <ExternalLink size={10} />
                  </button>{' '}
                  and create a free account (or sign in).
                </span>
              </li>
            )}
            {config.apiKeysUrl && (
              <li className="flex gap-2 text-xs text-muted">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-bold text-accent">
                  {config.consoleUrl ? 2 : 1}
                </span>
                <span className="pt-0.5">
                  Navigate to{' '}
                  <button
                    type="button"
                    onClick={() => handleOpenUrl(config.apiKeysUrl)}
                    className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline"
                  >
                    API Keys
                    <ExternalLink size={10} />
                  </button>{' '}
                  in the dashboard.
                </span>
              </li>
            )}
            {config.steps.map((step, i) => (
              <li key={step} className="flex gap-2 text-xs text-muted">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-bold text-accent">
                  {i + 1 + urlStepCount}
                </span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
          {config.helpUrl && (
            <button
              type="button"
              onClick={() => handleOpenUrl(config.helpUrl)}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              <ExternalLink size={12} />
              {config.helpLabel}
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4 text-left">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config.placeholder}
            className="w-full rounded-lg border border-border bg-card-bg px-4 py-2 text-sm font-mono text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          {error && <p className="text-sm text-red">{error}</p>}
          <button
            type="submit"
            disabled={saving || !apiKey.trim()}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save API Key'}
          </button>
        </form>
      </div>
    </div>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }): JSX.Element {
  return (
    <div className="text-center">
      <CheckCircle size={48} className="mx-auto mb-6 text-green-500" />
      <h1 className="text-3xl font-bold">You're All Set!</h1>
      <p className="mt-3 text-muted">
        DashSquad is ready. You can now deploy and manage your AI agents.
      </p>
      <button
        type="button"
        onClick={onFinish}
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Get Started
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
