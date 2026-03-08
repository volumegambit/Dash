import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle, Circle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ProviderConnectModal } from '../components/ProviderConnectModal.js';
import { PROVIDERS, PROVIDER_CONFIG, type Provider } from '../components/providers.js';

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 6)}${'•'.repeat(Math.min(12, key.length - 6))}`;
}

export function AiProviders(): JSX.Element {
  const [keys, setKeys] = useState<Record<Provider, string | null>>({
    anthropic: null,
    openai: null,
    google: null,
  });
  const [modal, setModal] = useState<Provider | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState<Provider | null>(null);

  const loadKeys = useCallback(async (): Promise<void> => {
    const results = await Promise.all(
      PROVIDERS.map(async (p) => {
        const value = await window.api.secretsGet(PROVIDER_CONFIG[p.id].secretKey);
        return [p.id, value] as [Provider, string | null];
      }),
    );
    setKeys(Object.fromEntries(results) as Record<Provider, string | null>);
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleSaved = (): void => {
    setModal(null);
    loadKeys();
  };

  const handleDisconnect = async (provider: Provider): Promise<void> => {
    await window.api.secretsDelete(PROVIDER_CONFIG[provider].secretKey);
    setDisconnectConfirm(null);
    loadKeys();
  };

  return (
    <div>
      <h1 className="text-2xl font-bold">AI Providers</h1>
      <p className="mt-2 text-muted">Connect AI providers to power your agents.</p>

      <div className="mt-6 space-y-4">
        {PROVIDERS.map((p) => {
          const key = keys[p.id];
          const isConnected = key !== null;
          const isConfirming = disconnectConfirm === p.id;

          return (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-border bg-sidebar-bg p-4"
            >
              <div className="flex items-center gap-3">
                {isConnected ? (
                  <CheckCircle size={18} className="shrink-0 text-green-500" />
                ) : (
                  <Circle size={18} className="shrink-0 text-muted" />
                )}
                <div>
                  <p className="text-sm font-semibold">{p.name}</p>
                  <p className="text-xs text-muted">
                    {isConnected && key !== null ? maskKey(key) : p.description}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {isConnected && !isConfirming && (
                  <>
                    <button
                      type="button"
                      onClick={() => setModal(p.id)}
                      className="text-xs text-primary hover:underline"
                    >
                      Update
                    </button>
                    <button
                      type="button"
                      onClick={() => setDisconnectConfirm(p.id)}
                      className="text-xs text-muted hover:text-foreground"
                    >
                      Disconnect
                    </button>
                  </>
                )}
                {isConnected && isConfirming && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">Remove key?</span>
                    <button
                      type="button"
                      onClick={() => handleDisconnect(p.id)}
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
                {!isConnected && (
                  <button
                    type="button"
                    onClick={() => setModal(p.id)}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <ProviderConnectModal
          provider={modal}
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
