import { providerSecretKey } from '@dash/mc/provider-keys';
import { ExternalLink, KeyRound, X } from 'lucide-react';
import { useState } from 'react';
import { PROVIDER_CONFIG, type Provider } from './providers.js';

const KEY_NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

interface ProviderConnectModalProps {
  provider: Provider;
  keyName?: string;
  onClose: () => void;
  onSaved: () => void;
}

export function ProviderConnectModal({
  provider,
  keyName,
  onClose,
  onSaved,
}: ProviderConnectModalProps): JSX.Element {
  const config = PROVIDER_CONFIG[provider];
  const [keyNameInput, setKeyNameInput] = useState(keyName ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consoleDomain = config.consoleUrl.replace(/^https?:\/\//, '');

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmedKey = apiKey.trim();
    const trimmedName = keyNameInput.trim();
    if (!trimmedKey || !trimmedName) return;
    if (!KEY_NAME_PATTERN.test(trimmedName)) {
      setError('Key name must contain only letters, numbers, and hyphens.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.api.secretsSet(providerSecretKey(provider, trimmedName), trimmedKey);
      setSaving(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const handleOpenUrl = async (url: string): Promise<void> => {
    try {
      await window.api.openExternal(url);
    } catch {
      window.open(url, '_blank');
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: custom modal uses div for flexible Tailwind styling */}
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg bg-background border border-border p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          e.stopPropagation();
        }}
      >
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <KeyRound size={20} className="text-muted" />
            <h2 className="text-lg font-semibold text-foreground">{config.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mb-4 text-sm text-muted">{config.explanation}</p>

        <div className="mb-4 rounded-lg border border-border bg-card-bg p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
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

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1.5 block text-sm text-foreground" htmlFor="key-name-input">
              Key name
            </label>
            <input
              id="key-name-input"
              type="text"
              value={keyNameInput}
              onChange={(e) => setKeyNameInput(e.target.value)}
              placeholder="Key name (e.g. default, high-volume)"
              aria-label="Key name"
              className="w-full rounded-lg border border-border bg-card-bg px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-foreground" htmlFor="api-key-input">
              API key
            </label>
            <input
              id="api-key-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config.placeholder}
              className="w-full rounded-lg border border-border bg-card-bg px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          {error && <p className="text-sm text-red">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !apiKey.trim() || !keyNameInput.trim()}
              className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save API Key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
