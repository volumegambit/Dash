import { ArrowRight, CheckCircle, KeyRound, Lock, Rocket } from 'lucide-react';
import { useState } from 'react';
import { useSecretsStore } from '../stores/secrets';

type Step = 'welcome' | 'password' | 'api-key' | 'done';

interface SetupWizardProps {
  needsSetup: boolean;
  needsApiKey: boolean;
  onComplete: () => void;
}

export function SetupWizard({
  needsSetup,
  needsApiKey,
  onComplete,
}: SetupWizardProps): JSX.Element {
  const initialStep = needsSetup ? 'welcome' : needsApiKey ? 'api-key' : 'done';
  const [step, setStep] = useState<Step>(initialStep);

  const handlePasswordDone = () => {
    if (needsApiKey) {
      setStep('api-key');
    } else {
      setStep('done');
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md px-4">
        {step === 'welcome' && <WelcomeStep onNext={() => setStep('password')} />}
        {step === 'password' && (
          <PasswordStep needsSetup={needsSetup} onDone={handlePasswordDone} />
        )}
        {step === 'api-key' && <ApiKeyStep onDone={() => setStep('done')} />}
        {step === 'done' && <DoneStep onFinish={onComplete} />}
      </div>
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <div className="text-center">
      <Rocket size={48} className="mx-auto mb-6 text-primary" />
      <h1 className="text-3xl font-bold">Welcome to Mission Control</h1>
      <p className="mt-3 text-muted">
        Deploy, manage, and monitor your Dash AI agents from a single dashboard. Let's get you set
        up in just a few steps.
      </p>
      <button
        type="button"
        onClick={onNext}
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Get Started
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

function PasswordStep({
  needsSetup,
  onDone,
}: { needsSetup: boolean; onDone: () => void }): JSX.Element {
  const { loading, error } = useSecretsStore();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const isCreate = needsSetup;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLocalError(null);

    if (isCreate && password !== confirm) {
      setLocalError('Passwords do not match.');
      return;
    }

    try {
      if (isCreate) {
        await useSecretsStore.getState().setup(password);
      } else {
        await useSecretsStore.getState().unlock(password);
      }
      onDone();
    } catch {
      // Error is set in the store
    }
  };

  return (
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
          className="w-full rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
        />
        {isCreate && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            className="w-full rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
          />
        )}
        {(localError || error) && <p className="text-sm text-red-400">{localError || error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {loading ? 'Processing...' : isCreate ? 'Create Password' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}

function ApiKeyStep({ onDone }: { onDone: () => void }): JSX.Element {
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
      await window.api.secretsSet('anthropic-api-key', trimmed);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="text-center">
      <KeyRound size={36} className="mx-auto mb-4 text-muted" />
      <h1 className="text-2xl font-bold">Add Anthropic API Key</h1>
      <p className="mt-2 text-sm text-muted">
        Your agents need an Anthropic API key to communicate with Claude. You can find your key at{' '}
        <span className="text-foreground">console.anthropic.com</span>.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4 text-left">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-..."
          className="w-full rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm font-mono text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={saving || !apiKey.trim()}
          className="w-full rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save API Key'}
        </button>
      </form>
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
        className="mt-8 inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Go to Dashboard
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
