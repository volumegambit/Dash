import { createFileRoute } from '@tanstack/react-router';
import { KeyRound, Loader, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSecretsStore } from '../stores/secrets';

function PasswordForm({
  title,
  description,
  confirmPassword,
  onSubmit,
  loading,
  error,
}: {
  title: string;
  description: string;
  confirmPassword: boolean;
  onSubmit: (password: string) => void;
  loading: boolean;
  error: string | null;
}): JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (confirmPassword && password !== confirm) {
      setLocalError('Passwords do not match.');
      return;
    }
    setLocalError(null);
    onSubmit(password);
  };

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Lock size={32} className="mx-auto mb-3 text-muted" />
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="mt-2 text-sm text-muted">{description}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-lg border border-border bg-card-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
          {confirmPassword && (
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
              className="w-full rounded-lg border border-border bg-card-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          )}
          {(localError || error) && <p className="text-sm text-red-400">{localError || error}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader size={14} className="animate-spin" />
                Processing...
              </span>
            ) : confirmPassword ? (
              'Create Password'
            ) : (
              'Unlock'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function AddSecretForm({ onAdd }: { onAdd: (key: string, value: string) => void }): JSX.Element {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!key.trim() || !value.trim()) return;
    onAdd(key.trim(), value.trim());
    setKey('');
    setValue('');
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="Key name"
        className="w-48 rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Secret value"
        className="flex-1 rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        disabled={!key.trim() || !value.trim()}
        className="flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
      >
        <Plus size={14} />
        Add
      </button>
    </form>
  );
}

function SecretsTable(): JSX.Element {
  const { keys, setSecret, deleteSecret, lock } = useSecretsStore();

  return (
    <div>
      {/* Page header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Secrets</h1>
          <p className="mt-1 text-sm text-muted">
            Encrypted key-value store for sensitive credentials
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => lock()}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
          >
            <Lock size={14} />
            Lock
          </button>
        </div>
      </div>

      {/* Info banner */}
      <div className="mb-6 bg-accent-tint border border-accent/30 rounded px-4 py-3 flex items-center gap-3">
        <ShieldCheck size={16} className="text-accent shrink-0" />
        <p className="text-sm text-muted">
          Secrets are encrypted with AES-256-GCM. Encryption key is stored in your OS keychain.
        </p>
      </div>

      <div className="mb-6">
        <AddSecretForm onAdd={(key, value) => setSecret(key, value)} />
      </div>

      {keys.length === 0 ? (
        <div className="rounded-lg border border-border bg-card-bg p-8 text-center">
          <KeyRound size={24} className="mx-auto mb-2 text-muted" />
          <p className="text-sm text-muted">No secrets stored yet.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card-bg">
          {/* Table header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-muted">
              Key
            </span>
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-muted">
              Value
            </span>
          </div>
          {keys.map((key, i) => (
            <div
              key={key}
              className={`flex items-center justify-between px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
            >
              <div className="flex items-center gap-3">
                <KeyRound size={14} className="text-muted" />
                <span className="font-[family-name:var(--font-mono)] text-sm text-foreground">
                  {key}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-[family-name:var(--font-mono)] text-sm text-muted">
                  ••••••••
                </span>
                <button
                  type="button"
                  onClick={() => deleteSecret(key)}
                  className="rounded p-1 text-muted transition-colors hover:bg-red-900/30 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Secrets(): JSX.Element {
  const { unlocked, needsSetup, loading, error, checkStatus } = useSecretsStore();

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  if (loading && !unlocked) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!unlocked && needsSetup) {
    return (
      <PasswordForm
        title="Set Up Encryption"
        description="Create a password to encrypt your secrets. This password will be required to access them."
        confirmPassword
        onSubmit={(password) => useSecretsStore.getState().setup(password)}
        loading={loading}
        error={error}
      />
    );
  }

  if (!unlocked) {
    return (
      <PasswordForm
        title="Unlock Secrets"
        description="Enter your encryption password to access stored secrets."
        confirmPassword={false}
        onSubmit={(password) => useSecretsStore.getState().unlock(password)}
        loading={loading}
        error={error}
      />
    );
  }

  return <SecretsTable />;
}

export const Route = createFileRoute('/secrets')({
  component: Secrets,
});
