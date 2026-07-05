import { providerSecretKey } from '@dash/mc/provider-keys';
import { useCallback, useEffect, useState } from 'react';

export function WebSearchSettings(): JSX.Element {
  const [keys, setKeys] = useState<string[]>([]);
  const [braveKeyMasked, setBraveKeyMasked] = useState<string | null>(null);
  const [braveKeyInput, setBraveKeyInput] = useState('');
  const [braveKeySaving, setBraveKeySaving] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      const credKeys = await window.api.credentialsList();
      setKeys(credKeys);
    } catch {
      // Gateway may not be ready
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    const braveKey = providerSecretKey('brave');
    const hasBrave = keys.some((k) => k.startsWith(braveKey));
    if (!hasBrave) {
      setBraveKeyMasked(null);
    }
    // Note: gateway credentials API only lists keys, not values.
    // We can't unmask the key, so just show a placeholder when present.
    if (hasBrave) {
      setBraveKeyMasked('••••••••••••••••');
    }
  }, [keys]);

  const handleSaveBraveKey = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = braveKeyInput.trim();
      if (!trimmed) return;
      setBraveKeySaving(true);
      try {
        await window.api.credentialsSet(providerSecretKey('brave'), trimmed);
        setBraveKeyMasked(`${trimmed.slice(0, 6)}${'•'.repeat(6)}${trimmed.slice(-4)}`);
        setBraveKeyInput('');
        await loadKeys();
      } finally {
        setBraveKeySaving(false);
      }
    },
    [braveKeyInput, loadKeys],
  );

  const handleRemoveBraveKey = useCallback(async () => {
    await window.api.credentialsRemove(providerSecretKey('brave'));
    setBraveKeyMasked(null);
    setBraveKeyInput('');
    await loadKeys();
  }, [loadKeys]);

  return (
    <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
      <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
        Web Search
      </h2>
      <p className="mb-4 text-xs text-muted">
        Agents with the <span className="font-mono text-foreground">web_search</span> tool enabled
        will use this Brave Search API key. Get one at{' '}
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
  );
}
