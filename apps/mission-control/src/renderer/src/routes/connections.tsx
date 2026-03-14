import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle, Circle, Lock, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ProviderConnectModal } from '../components/ProviderConnectModal.js';
import { PROVIDERS, type Provider } from '../components/providers.js';

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 6)}${'•'.repeat(Math.min(12, key.length - 6))}`;
}

interface ProviderKeyEntry {
  name: string;
  value: string;
}

export function AiProviders(): JSX.Element {
  const [providerKeys, setProviderKeys] = useState<Record<string, ProviderKeyEntry[]>>({});
  const [locked, setLocked] = useState(false);
  const [modal, setModal] = useState<{ provider: Provider; keyName?: string } | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState<{
    provider: Provider;
    keyName: string;
  } | null>(null);

  const loadKeys = useCallback(async (): Promise<void> => {
    const unlocked = await window.api.secretsIsUnlocked();
    if (!unlocked) {
      setLocked(true);
      return;
    }
    setLocked(false);
    const allKeys = await window.api.secretsList();
    const grouped: Record<string, ProviderKeyEntry[]> = {};
    for (const p of PROVIDERS) {
      const prefix = `${p.id}-api-key:`;
      const matching = allKeys.filter((k: string) => k.startsWith(prefix));
      const entries: ProviderKeyEntry[] = [];
      for (const key of matching) {
        try {
          const value = await window.api.secretsGet(key);
          if (value) {
            entries.push({ name: key.slice(prefix.length), value });
          }
        } catch {
          // skip
        }
      }
      grouped[p.id] = entries;
    }
    setProviderKeys(grouped);
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleSaved = (): void => {
    setModal(null);
    loadKeys();
  };

  const handleDisconnect = async (provider: Provider, keyName: string): Promise<void> => {
    await window.api.secretsDelete(`${provider}-api-key:${keyName}`);
    setDisconnectConfirm(null);
    loadKeys();
  };

  return (
    <div>
      <h1 className="text-2xl font-bold">AI Providers</h1>
      <p className="mt-2 text-muted">Connect AI providers to power your agents.</p>

      {locked && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-sidebar-bg px-4 py-3 text-sm text-muted">
          <Lock size={16} className="shrink-0" />
          <span>
            Secrets are locked. Unlock your secrets store to view provider status.
          </span>
        </div>
      )}

      <div className="mt-6 space-y-6">
        {PROVIDERS.map((p) => {
          const keys = providerKeys[p.id] ?? [];
          const hasKeys = keys.length > 0;

          return (
            <div key={p.id} className="rounded-lg border border-border bg-sidebar-bg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {hasKeys ? (
                    <CheckCircle size={18} className="shrink-0 text-green-500" />
                  ) : (
                    <Circle size={18} className="shrink-0 text-muted" />
                  )}
                  <div>
                    <p className="text-sm font-semibold">{p.name}</p>
                    <p className="text-xs text-muted">{p.description}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setModal({
                      provider: p.id,
                      keyName: hasKeys ? undefined : 'default',
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                >
                  <Plus size={14} />
                  Add Key
                </button>
              </div>

              {keys.length > 0 && (
                <div className="mt-3 space-y-2">
                  {keys.map((entry) => {
                    const isConfirming =
                      disconnectConfirm?.provider === p.id &&
                      disconnectConfirm?.keyName === entry.name;

                    return (
                      <div
                        key={entry.name}
                        className="flex items-center justify-between rounded border border-border bg-background px-3 py-2"
                      >
                        <div>
                          <span className="text-xs font-medium text-foreground">
                            {entry.name}
                          </span>
                          <span className="ml-2 text-xs text-muted">
                            {maskKey(entry.value)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {!isConfirming && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  setModal({ provider: p.id, keyName: entry.name })
                                }
                                className="text-xs text-primary hover:underline"
                              >
                                Update
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setDisconnectConfirm({
                                    provider: p.id,
                                    keyName: entry.name,
                                  })
                                }
                                className="text-xs text-muted hover:text-foreground"
                              >
                                Remove
                              </button>
                            </>
                          )}
                          {isConfirming && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted">Remove key?</span>
                              <button
                                type="button"
                                onClick={() => handleDisconnect(p.id, entry.name)}
                                className="text-xs text-red-400 hover:underline"
                              >
                                Yes, remove
                              </button>
                              <button
                                type="button"
                                onClick={() => setDisconnectConfirm(null)}
                                className="text-xs text-muted hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {modal && (
        <ProviderConnectModal
          provider={modal.provider}
          keyName={modal.keyName}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute('/connections')({
  component: AiProviders,
});
