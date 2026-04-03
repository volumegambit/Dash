import { providerSecretKey } from '@dash/mc/provider-keys';
import { createFileRoute } from '@tanstack/react-router';
import { KeyRound, Loader, Lock, LogIn, Pencil, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ProviderConnectModal } from '../components/ProviderConnectModal.js';
import { PROVIDERS, type Provider } from '../components/providers.js';

function maskKey(key: string): string {
  if (key.length <= 17) return '••••••••';
  return `${key.slice(0, 10)}${'•'.repeat(6)}${key.slice(-7)}`;
}

const KEY_NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

type OAuthProvider = 'openai' | 'anthropic';

const OAUTH_CONFIG: Record<OAuthProvider, { label: string; badgeLabel: string }> = {
  openai: { label: 'Add Codex Login Key', badgeLabel: 'Codex' },
  anthropic: { label: 'Add Claude Login Key', badgeLabel: 'Claude' },
};

function hasOAuthSupport(providerId: string): providerId is OAuthProvider {
  return providerId in OAUTH_CONFIG;
}

interface ProviderKeyEntry {
  name: string;
  value: string;
  isOAuth?: boolean;
}

export function AiProviders(): JSX.Element {
  const [providerKeys, setProviderKeys] = useState<Record<string, ProviderKeyEntry[]>>({});
  const [locked, setLocked] = useState(false);
  const [modal, setModal] = useState<{ provider: Provider; keyName?: string } | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] = useState<{
    provider: Provider;
    keyName: string;
  } | null>(null);
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);
  const [oauthError, setOauthError] = useState<{ provider: OAuthProvider; message: string } | null>(
    null,
  );
  const [codexOAuthModal, setCodexOAuthModal] = useState(false);
  const [codexOAuthName, setCodexOAuthName] = useState('');
  // Claude OAuth modal state (combines name + code in one modal)
  const [claudeOAuthModal, setClaudeOAuthModal] = useState<{
    state: string;
    verifier: string;
  } | null>(null);
  const [claudeOAuthName, setClaudeOAuthName] = useState('');
  const [claudeOAuthCode, setClaudeOAuthCode] = useState('');
  const [claudeOAuthError, setClaudeOAuthError] = useState<string | null>(null);

  const loadKeys = useCallback(async (): Promise<void> => {
    const unlocked = await window.api.secretsIsUnlocked();
    if (!unlocked) {
      setLocked(true);
      return;
    }
    setLocked(false);
    const allKeys = await window.api.secretsList();
    // Codex OAuth keys have a matching refresh token
    const codexRefreshKeys = new Set(
      allKeys
        .filter((k: string) => k.startsWith('openai-codex-refresh:'))
        .map((k: string) => k.slice('openai-codex-refresh:'.length)),
    );
    // Claude OAuth keys: we mark keys created via OAuth by storing a marker
    const claudeOAuthKeys = new Set(
      allKeys
        .filter((k: string) => k.startsWith('anthropic-oauth-marker:'))
        .map((k: string) => k.slice('anthropic-oauth-marker:'.length)),
    );
    const grouped: Record<string, ProviderKeyEntry[]> = {};
    for (const p of PROVIDERS) {
      const prefix = `${p.id}-api-key:`;
      const matching = allKeys.filter((k: string) => k.startsWith(prefix));
      const entries: ProviderKeyEntry[] = [];
      for (const key of matching) {
        try {
          const value = await window.api.secretsGet(key);
          if (value) {
            const name = key.slice(prefix.length);
            const isOAuth =
              (p.id === 'openai' && codexRefreshKeys.has(name)) ||
              (p.id === 'anthropic' && claudeOAuthKeys.has(name));
            entries.push({ name, value, isOAuth });
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
    await window.api.secretsDelete(providerSecretKey(provider, keyName));
    // Clean up OAuth metadata
    await window.api.secretsDelete(`openai-codex-refresh:${keyName}`).catch(() => {});
    await window.api.secretsDelete(`openai-codex-expires:${keyName}`).catch(() => {});
    await window.api.secretsDelete(`anthropic-oauth-marker:${keyName}`).catch(() => {});
    setDisconnectConfirm(null);
    loadKeys();
  };

  /** Suggest "default" or "default-2", "default-3", etc. if taken */
  const suggestClaudeLabel = useCallback((): string => {
    const existing = (providerKeys.anthropic ?? []).map((k) => k.name);
    const base = 'default';
    if (!existing.includes(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.includes(candidate)) return candidate;
    }
  }, [providerKeys]);

  const suggestCodexLabel = useCallback((): string => {
    const existing = (providerKeys.openai ?? []).map((k) => k.name);
    const base = 'default';
    if (!existing.includes(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.includes(candidate)) return candidate;
    }
  }, [providerKeys]);

  /** Start Claude OAuth: immediately open browser + show modal */
  const handleClaudeOAuthStart = async (prefillName?: string): Promise<void> => {
    setOauthError(null);
    setClaudeOAuthError(null);
    try {
      const { state, verifier } = await window.api.claudePrepareOAuth();
      setClaudeOAuthModal({ state, verifier });
      setClaudeOAuthName(prefillName ?? suggestClaudeLabel());
      setClaudeOAuthCode('');
    } catch (err) {
      setOauthError({ provider: 'anthropic', message: (err as Error).message });
    }
  };

  /** Complete Claude OAuth: validate label + exchange code */
  const handleClaudeOAuthSubmit = async (): Promise<void> => {
    if (!claudeOAuthModal) return;
    const name = claudeOAuthName.trim();
    const code = claudeOAuthCode.trim();
    if (!name || !code) return;
    if (!KEY_NAME_PATTERN.test(name)) {
      setClaudeOAuthError('Label must contain only letters, numbers, and hyphens.');
      return;
    }
    setOauthLoading('anthropic');
    setClaudeOAuthError(null);
    try {
      const result = await window.api.claudeCompleteOAuth(
        name,
        code,
        claudeOAuthModal.state,
        claudeOAuthModal.verifier,
      );
      if (result.success) {
        setClaudeOAuthModal(null);
        loadKeys();
      } else {
        setClaudeOAuthError(result.error ?? 'Login failed');
      }
    } catch (err) {
      setClaudeOAuthError((err as Error).message);
    } finally {
      setOauthLoading(null);
    }
  };

  const handleOAuthLogin = async (provider: OAuthProvider, keyName: string): Promise<void> => {
    setOauthLoading(provider);
    setOauthError(null);
    setCodexOAuthModal(false);
    try {
      if (provider === 'openai') {
        const result = await window.api.codexStartOAuth(keyName);
        if (result.success) {
          loadKeys();
        } else {
          setOauthError({ provider, message: result.error ?? 'Login failed' });
        }
      } else {
        // Anthropic uses the modal flow
        await handleClaudeOAuthStart(keyName);
      }
    } catch (err) {
      setOauthError({ provider, message: (err as Error).message });
    } finally {
      setOauthLoading(null);
    }
  };

  const handleCodexOAuthSubmit = (): void => {
    const name = codexOAuthName.trim();
    if (!name) return;
    if (!KEY_NAME_PATTERN.test(name)) {
      setOauthError({
        provider: 'openai',
        message: 'Label must contain only letters, numbers, and hyphens.',
      });
      return;
    }
    setCodexOAuthModal(false);
    handleOAuthLogin('openai', name);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface border-b border-border flex justify-between items-center px-8 py-4 shrink-0">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            AI Providers
          </h1>
          <p className="text-sm text-muted">Configure API keys for LLM providers</p>
        </div>
      </div>

      {/* Body */}
      <div className="p-8 flex-1 overflow-y-auto">
        {locked && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-border bg-card-bg px-4 py-3 text-sm text-muted">
            <Lock size={16} className="shrink-0" />
            <span>Secrets are locked. Unlock your secrets store to view provider status.</span>
          </div>
        )}

        <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
          Configured Providers
        </p>

        <div className="flex flex-col gap-3 mt-4">
          {PROVIDERS.map((p) => {
            const keys = providerKeys[p.id] ?? [];
            const hasKeys = keys.length > 0;
            const oauthSupported = hasOAuthSupport(p.id);
            const oauthConfig = oauthSupported ? OAUTH_CONFIG[p.id] : null;
            const isThisOAuthLoading = oauthLoading === p.id;
            const isAnyOAuthLoading = oauthLoading !== null;

            return (
              <div key={p.id} className="bg-card-bg border border-border">
                {/* Provider row */}
                <div className="px-5 py-4 flex items-center gap-4 hover:bg-card-hover transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-foreground">{p.name}</p>
                    <p className="font-[family-name:var(--font-mono)] text-xs text-muted mt-0.5">
                      {hasKeys ? keys.map((k) => k.name).join(', ') : 'API key configured'}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* Status badge */}
                    {hasKeys ? (
                      <span className="bg-green-tint text-green rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
                        Active
                      </span>
                    ) : (
                      <span className="bg-red-tint text-red rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
                        Disabled
                      </span>
                    )}

                    {/* OAuth button */}
                    {oauthSupported && oauthConfig && (
                      <button
                        type="button"
                        onClick={() => {
                          if (p.id === 'anthropic') {
                            handleClaudeOAuthStart();
                          } else {
                            setCodexOAuthName(suggestCodexLabel());
                            setOauthError(null);
                            setCodexOAuthModal(true);
                          }
                        }}
                        disabled={isAnyOAuthLoading}
                        className="inline-flex items-center gap-1 rounded-lg border border-green-700 bg-green-900/20 px-3 py-1.5 text-xs font-medium text-green hover:bg-green-900/40 disabled:opacity-50"
                      >
                        {isThisOAuthLoading ? (
                          <Loader size={14} className="animate-spin" />
                        ) : (
                          <LogIn size={14} />
                        )}
                        {isThisOAuthLoading ? 'Logging in...' : oauthConfig.label}
                      </button>
                    )}

                    {/* Edit button */}
                    <button
                      type="button"
                      onClick={() =>
                        setModal({
                          provider: p.id,
                          keyName: hasKeys ? undefined : 'default',
                        })
                      }
                      className="text-muted hover:text-foreground transition-colors"
                      aria-label={`Edit ${p.name}`}
                    >
                      <Pencil size={15} />
                    </button>

                    {/* Delete button */}
                    {hasKeys && keys.length === 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setDisconnectConfirm({ provider: p.id, keyName: keys[0].name })
                        }
                        className="text-muted hover:text-foreground transition-colors"
                        aria-label={`Remove ${p.name}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>


                {/* OAuth error */}
                {oauthError?.provider === p.id && (
                  <div className="mx-5 mb-4 rounded border border-red-900/50 bg-red-900/20 px-3 py-2 text-xs text-red">
                    {oauthError.message}
                  </div>
                )}

                {/* Key entries */}
                {keys.length > 0 && (
                  <div className="px-5 pb-4 space-y-2">
                    {keys.map((entry) => {
                      const isConfirming =
                        disconnectConfirm?.provider === p.id &&
                        disconnectConfirm?.keyName === entry.name;
                      const oauthConfigForEntry =
                        oauthSupported && entry.isOAuth
                          ? OAUTH_CONFIG[p.id as OAuthProvider]
                          : null;

                      return (
                        <div
                          key={entry.name}
                          className="flex items-center justify-between rounded border border-border bg-background px-3 py-2"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">
                              {entry.name}
                            </span>
                            {entry.isOAuth && oauthConfigForEntry && (
                              <span className="rounded bg-green-900/30 px-1.5 py-0.5 text-[10px] font-medium text-green">
                                {oauthConfigForEntry.badgeLabel}
                              </span>
                            )}
                            <span className="text-xs text-muted">{maskKey(entry.value)}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {!isConfirming && (
                              <>
                                {entry.isOAuth && oauthSupported ? (
                                  <button
                                    type="button"
                                    onClick={() => handleOAuthLogin(p.id, entry.name)}
                                    disabled={isAnyOAuthLoading}
                                    className="text-xs text-accent hover:underline disabled:opacity-50"
                                  >
                                    Re-login
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setModal({ provider: p.id, keyName: entry.name })
                                    }
                                    className="text-xs text-accent hover:underline"
                                  >
                                    Update
                                  </button>
                                )}
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
                                  className="text-xs text-red hover:underline"
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
      </div>

      {modal && (
        <ProviderConnectModal
          provider={modal.provider}
          keyName={modal.keyName}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Codex OAuth modal */}
      {codexOAuthModal && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setCodexOAuthModal(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setCodexOAuthModal(false);
          }}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: custom modal uses div for flexible Tailwind styling */}
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md bg-background border border-border p-6"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <KeyRound size={20} className="text-muted" />
                <h2 className="text-lg font-semibold text-foreground">Codex Login</h2>
              </div>
              <button
                type="button"
                onClick={() => setCodexOAuthModal(false)}
                className="p-1 text-muted hover:text-foreground"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <p className="mb-4 text-sm text-muted">
              Choose a label for this connection. A browser window will open for you to sign in to
              your OpenAI account.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCodexOAuthSubmit();
              }}
              className="space-y-3"
            >
              <div>
                <label className="mb-1.5 block text-xs text-muted" htmlFor="codex-oauth-name">
                  Connection label
                </label>
                <input
                  id="codex-oauth-name"
                  type="text"
                  value={codexOAuthName}
                  onChange={(e) => setCodexOAuthName(e.target.value)}
                  placeholder="e.g. default, personal, work"
                  // biome-ignore lint/a11y/noAutofocus: focus primary input in modal
                  autoFocus
                  className="w-full border border-border bg-card-bg px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              {oauthError?.provider === 'openai' && (
                <p className="text-sm text-red">{oauthError.message}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setCodexOAuthModal(false)}
                  className="flex-1 border border-border px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!codexOAuthName.trim() || oauthLoading === 'openai'}
                  className="flex-1 bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50 inline-flex items-center justify-center gap-1"
                >
                  {oauthLoading === 'openai' && <Loader size={14} className="animate-spin" />}
                  {oauthLoading === 'openai' ? 'Logging in...' : 'Login'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Claude OAuth modal */}
      {claudeOAuthModal && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => {
            setClaudeOAuthModal(null);
            setClaudeOAuthError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setClaudeOAuthModal(null);
              setClaudeOAuthError(null);
            }
          }}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: custom modal uses div for flexible Tailwind styling */}
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-lg bg-background border border-border p-6"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <KeyRound size={20} className="text-muted" />
                <h2 className="text-lg font-semibold text-foreground">Claude Login</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setClaudeOAuthModal(null);
                  setClaudeOAuthError(null);
                }}
                className="rounded p-1 text-muted hover:text-foreground"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <p className="mb-4 text-sm text-muted">
              A browser window has opened. Sign in to Claude and copy the authorization code, then
              paste it below.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleClaudeOAuthSubmit();
              }}
              className="space-y-3"
            >
              <div>
                <label className="mb-1.5 block text-xs text-muted" htmlFor="claude-oauth-code">
                  Authorization code
                </label>
                <input
                  id="claude-oauth-code"
                  type="text"
                  value={claudeOAuthCode}
                  onChange={(e) => setClaudeOAuthCode(e.target.value)}
                  placeholder="Paste authorization code here"
                  // biome-ignore lint/a11y/noAutofocus: focus primary input in modal
                  autoFocus
                  className="w-full rounded-lg border border-border bg-card-bg px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs text-muted" htmlFor="claude-oauth-name">
                  Connection label
                </label>
                <input
                  id="claude-oauth-name"
                  type="text"
                  value={claudeOAuthName}
                  onChange={(e) => setClaudeOAuthName(e.target.value)}
                  placeholder="e.g. claude-login"
                  className="w-full rounded-lg border border-border bg-card-bg px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              {claudeOAuthError && <p className="text-sm text-red">{claudeOAuthError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setClaudeOAuthModal(null);
                    setClaudeOAuthError(null);
                  }}
                  className="flex-1 rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    !claudeOAuthCode.trim() ||
                    !claudeOAuthName.trim() ||
                    oauthLoading === 'anthropic'
                  }
                  className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50 inline-flex items-center justify-center gap-1"
                >
                  {oauthLoading === 'anthropic' && <Loader size={14} className="animate-spin" />}
                  {oauthLoading === 'anthropic' ? 'Verifying...' : 'Connect'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/connections')({
  component: AiProviders,
});
