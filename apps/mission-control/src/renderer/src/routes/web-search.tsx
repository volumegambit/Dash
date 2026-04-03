import { providerSecretKey } from '@dash/mc/provider-keys';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useSecretsStore } from '../stores/secrets.js';

function WebSearch(): JSX.Element {
  const { loadKeys, setSecret, deleteSecret, getSecret } = useSecretsStore();
  const keys = useSecretsStore((s) => s.keys);
  const [braveKeyMasked, setBraveKeyMasked] = useState<string | null>(null);
  const [braveKeyInput, setBraveKeyInput] = useState('');
  const [braveKeySaving, setBraveKeySaving] = useState(false);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    const hasBrave = keys.some((k) => k.startsWith(providerSecretKey('brave')));
    if (hasBrave) {
      getSecret(providerSecretKey('brave')).then((val) => {
        if (val) {
          setBraveKeyMasked(`${val.slice(0, 6)}${'•'.repeat(6)}${val.slice(-4)}`);
        }
      });
    } else {
      setBraveKeyMasked(null);
    }
  }, [keys, getSecret]);

  const handleSaveBraveKey = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = braveKeyInput.trim();
      if (!trimmed) return;
      setBraveKeySaving(true);
      try {
        await setSecret(providerSecretKey('brave'), trimmed);
        setBraveKeyMasked(`${trimmed.slice(0, 6)}${'•'.repeat(6)}${trimmed.slice(-4)}`);
        setBraveKeyInput('');
      } finally {
        setBraveKeySaving(false);
      }
    },
    [braveKeyInput, setSecret],
  );

  const handleRemoveBraveKey = useCallback(async () => {
    await deleteSecret(providerSecretKey('brave'));
    setBraveKeyMasked(null);
    setBraveKeyInput('');
  }, [deleteSecret]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            Web Search
          </h1>
          <p className="mt-1 text-sm text-muted">
            Enable agents to search the web during conversations.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="rounded-lg border border-border bg-card-bg p-4">
          <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            Brave Search API Key
          </h2>
          <p className="mb-4 text-xs text-muted">
            Agents with the <span className="font-mono text-foreground">web_search</span> tool
            enabled will use this key. Get one at{' '}
            <button
              type="button"
              onClick={() => window.api.openExternal('https://brave.com/search/api/')}
              className="text-accent hover:underline"
            >
              brave.com/search/api
            </button>
            .
          </p>
          {braveKeyMasked ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 rounded border border-border bg-card-bg px-3 py-1.5 text-xs font-mono text-muted">
                {braveKeyMasked}
              </span>
              <button
                type="button"
                onClick={handleRemoveBraveKey}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-red hover:bg-red-900/20"
              >
                Remove
              </button>
            </div>
          ) : (
            <form className="flex gap-2" onSubmit={handleSaveBraveKey}>
              <input
                type="password"
                value={braveKeyInput}
                onChange={(e) => setBraveKeyInput(e.target.value)}
                placeholder="BSA-xxxxxxxxxxxxxxxx"
                className="flex-1 rounded-lg border border-border bg-card-bg px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={!braveKeyInput.trim() || braveKeySaving}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {braveKeySaving ? 'Saving...' : 'Save'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/web-search')({
  component: WebSearch,
});
