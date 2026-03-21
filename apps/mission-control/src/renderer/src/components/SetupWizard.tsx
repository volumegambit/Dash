import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle,
  ExternalLink,
  KeyRound,
  Lock,
  Rocket,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { PROVIDERS, PROVIDER_CONFIG, type Provider } from './providers.js';

type Step = 'welcome' | 'password' | 'provider' | 'api-key' | 'done';

interface SetupWizardProps {
  needsSetup: boolean;
  needsUnlock: boolean;
  needsApiKey: boolean;
  onComplete: () => void;
}

export function SetupWizard({
  needsSetup,
  needsUnlock,
  needsApiKey,
  onComplete,
}: SetupWizardProps): JSX.Element {
  const initialStep = needsSetup
    ? 'welcome'
    : needsUnlock
      ? 'password'
      : needsApiKey
        ? 'provider'
        : 'done';
  const [step, setStep] = useState<Step>(initialStep);
  const [provider, setProvider] = useState<Provider>('anthropic');

  const handlePasswordDone = () => {
    if (needsApiKey) {
      setStep('provider');
    } else {
      setStep('done');
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md px-4">
        {step === 'welcome' && <WelcomeStep onNext={() => setStep('password')} />}
        {step === 'password' && (
          <PasswordStep
            needsSetup={needsSetup}
            onBack={needsUnlock ? undefined : () => setStep('welcome')}
            onDone={handlePasswordDone}
          />
        )}
        {step === 'provider' && (
          <ProviderStep
            selected={provider}
            onSelect={setProvider}
            onBack={() => setStep('password')}
            onNext={() => setStep('api-key')}
          />
        )}
        {step === 'api-key' && (
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

function BackButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-6 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
    >
      <ArrowLeft size={14} />
      Back
    </button>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div className="text-center">
      <Zap size={48} className="mx-auto mb-6 text-accent" />
      <h1 className="text-3xl font-bold">Welcome to Mission Control</h1>
      <p className="mt-3 text-muted">
        Deploy, manage, and monitor your Dash AI agents from a single dashboard. Let's get you set
        up in just a few steps.
      </p>
      <button
        type="button"
        onClick={onNext}
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Get Started
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

function PasswordStep({
  needsSetup,
  onBack,
  onDone,
}: { needsSetup: boolean; onBack?: () => void; onDone: () => void }): JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreate = needsSetup;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);

    if (isCreate && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      if (isCreate) {
        await window.api.secretsSetup(password);
      } else {
        await window.api.secretsUnlock(password);
      }
      onDone();
    } catch (err) {
      setError(isCreate ? (err as Error).message : 'Wrong password. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div>
      {onBack && <BackButton onClick={onBack} />}
      <div className="text-center">
        <Lock size={36} className="mx-auto mb-4 text-muted" />
        <h1 className="text-2xl font-bold">
          {isCreate ? 'Create Encryption Password' : 'Unlock Secrets'}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {isCreate
            ? 'Your secrets are encrypted at rest. Create a password to protect your API keys and tokens.'
            : 'Enter your password to unlock your encrypted secrets store.'}
        </p>
        <form onSubmit={handleSubmit} className="mt-6 space-y-4 text-left">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-lg border border-border bg-card-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          {isCreate && (
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
              className="w-full rounded-lg border border-border bg-card-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {loading ? 'Processing...' : isCreate ? 'Create Password' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}

function ProviderStep({
  selected,
  onSelect,
  onBack,
  onNext,
}: {
  selected: Provider;
  onSelect: (p: Provider) => void;
  onBack: () => void;
  onNext: () => void;
}): JSX.Element {
  return (
    <div>
      <BackButton onClick={onBack} />
      <div className="text-center">
        <Bot size={36} className="mx-auto mb-4 text-muted" />
        <h1 className="text-2xl font-bold">Choose Your AI Provider</h1>
        <p className="mt-2 text-sm text-muted">
          Your agents need an AI model to think and respond. Choose one provider to get started
          &mdash; you only need one, but you can add more later in Settings.
        </p>

        <div className="mt-6 space-y-3 text-left">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!p.available}
              onClick={() => onSelect(p.id)}
              className={`w-full rounded-lg border-2 px-4 py-4 text-left transition-colors ${
                selected === p.id
                  ? 'border-accent bg-accent-tint'
                  : 'border-border bg-card-bg hover:border-muted'
              } ${!p.available ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">{p.name}</span>
                {selected === p.id && <CheckCircle size={18} className="text-accent" />}
                {!p.available && (
                  <span className="rounded-full bg-border px-2 py-0.5 text-[10px] font-medium text-muted">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">{p.description}</p>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onNext}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
        >
          Continue with {PROVIDERS.find((p) => p.id === selected)?.name ?? 'selected provider'}
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

function ApiKeyStep({
  provider,
  onBack,
  onDone,
}: { provider: Provider; onBack: () => void; onDone: () => void }): JSX.Element {
  const config = PROVIDER_CONFIG[provider];
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) return;

    setSaving(true);
    setError(null);
    try {
      await window.api.secretsSet(config.secretKey, trimmed);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
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

  return (
    <div>
      <BackButton onClick={onBack} />
      <div className="text-center">
        <KeyRound size={36} className="mx-auto mb-4 text-muted" />
        <h1 className="text-2xl font-bold">{config.title}</h1>
        <p className="mt-2 text-sm text-muted">{config.explanation}</p>

        <div className="mt-4 rounded-lg border border-border bg-card-bg p-4 text-left">
          <p className="mb-3 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-muted">
            How to get your key
          </p>
          <ol className="space-y-2">
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
            <li className="flex gap-2 text-xs text-muted">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-bold text-accent">
                2
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
            {config.steps.map((step, i) => (
              <li key={step} className="flex gap-2 text-xs text-muted">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-bold text-accent">
                  {i + 3}
                </span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => handleOpenUrl(config.helpUrl)}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            <ExternalLink size={12} />
            {config.helpLabel}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4 text-left">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config.placeholder}
            className="w-full rounded-lg border border-border bg-card-bg px-4 py-2 text-sm font-mono text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
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
        Mission Control is ready. You can now deploy and manage your AI agents.
      </p>
      <button
        type="button"
        onClick={onFinish}
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Go to Dashboard
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
