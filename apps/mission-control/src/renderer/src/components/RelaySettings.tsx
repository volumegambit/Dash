import { useCallback, useEffect, useState } from 'react';
import type { RelayConfigStatus } from '../../../shared/ipc.js';

/**
 * Settings section for remote access via a self-hosted relay. The relay token
 * and admin secret are secrets — they go to the OS keychain via IPC and are
 * never read back here (the inputs always start blank; we only learn whether
 * relay mode is currently configured). Saving restarts the gateway so it dials
 * the relay, which is why the controls disable while busy.
 */
export function RelaySettings(): JSX.Element {
  const [status, setStatus] = useState<RelayConfigStatus | null>(null);
  const [zone, setZone] = useState('');
  const [relayToken, setRelayToken] = useState('');
  const [adminSecret, setAdminSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api
      .relayGetConfig()
      .then((s) => {
        setStatus(s);
        setZone(s.zone ?? '');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.api.relaySetConfig({ zone: zone.trim(), relayToken, adminSecret });
      setRelayToken('');
      setAdminSecret('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable relay');
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.api.relayClearConfig();
      setRelayToken('');
      setAdminSecret('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disable relay');
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    zone.trim().length > 0 && relayToken.length > 0 && adminSecret.length > 0 && !busy;
  const inputClass =
    'w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent';

  return (
    <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
      <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
        Remote access (relay)
      </h2>
      <p className="mb-3 max-w-xl text-xs text-muted">
        Reach your agents from your phone over the internet through a self-hosted Dash relay. Enter
        the same relay domain, token and admin secret you configured on your relay. Leave this off
        to pair over your local network only.
      </p>

      {status?.configured && (
        <p data-testid="relay-status" className="mb-3 text-xs text-green">
          Relay enabled for <span className="font-mono text-foreground">{status.zone}</span>
        </p>
      )}

      <div className="grid max-w-xl gap-3">
        <label className="grid gap-1 text-xs text-muted">
          Relay domain
          <input
            aria-label="Relay domain"
            type="text"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            placeholder="relay.example.com"
            className={inputClass}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Relay token
          <input
            aria-label="Relay token"
            type="password"
            value={relayToken}
            onChange={(e) => setRelayToken(e.target.value)}
            placeholder={status?.configured ? '•••••••• (leave to re-enter)' : 'shared relay token'}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Admin secret
          <input
            aria-label="Admin secret"
            type="password"
            value={adminSecret}
            onChange={(e) => setAdminSecret(e.target.value)}
            placeholder="relay admin secret"
            className={inputClass}
          />
        </label>
      </div>

      {error && <p className="mt-3 text-xs text-red">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition disabled:opacity-50"
        >
          {busy ? 'Saving…' : status?.configured ? 'Update relay' : 'Enable relay'}
        </button>
        {status?.configured && (
          <button
            type="button"
            onClick={disable}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition disabled:opacity-50"
          >
            Disable relay
          </button>
        )}
      </div>
    </div>
  );
}
