import { useCallback, useEffect, useState } from 'react';
import type { ControlPlaneStatus, DeviceInfo } from '../../../shared/ipc.js';

/**
 * Settings section for remote access via the hosted Dash relay. The user signs
 * in to Dash (WorkOS, system browser), enrolls a gateway, and manages the
 * devices paired to it. No secrets are entered here — the control-plane session
 * token and the gateway's issued identity live in the OS keychain and are never
 * read back to the renderer (we only learn the derived sign-in/enroll status).
 *
 * This is the structural wiring; visual polish and the live browser flow are
 * exercised by manual MC QA.
 */
export function RelaySettings(): JSX.Element {
  const [status, setStatus] = useState<ControlPlaneStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api
      .controlPlaneStatus()
      .then((s) => {
        setStatus(s);
        if (s.enrolled) {
          window.api
            .devicesList()
            .then(setDevices)
            .catch(() => {});
        } else {
          setDevices([]);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<void>, fallbackMsg: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallbackMsg);
    } finally {
      setBusy(false);
    }
  };

  const signIn = (): Promise<void> => run(() => window.api.controlPlaneSignIn(), 'Sign-in failed');
  const enroll = (): Promise<void> =>
    run(() => window.api.gatewayEnroll(), 'Could not enroll a gateway');
  const revoke = (id: string): Promise<void> =>
    run(() => window.api.devicesRevoke(id), 'Could not revoke device');

  const btnPrimary =
    'inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition disabled:opacity-50';
  const btnSecondary =
    'inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition disabled:opacity-50';

  return (
    <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
      <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
        Remote access
      </h2>
      <p className="mb-3 max-w-xl text-xs text-muted">
        Reach your agents from your phone over the internet through the hosted Dash relay. Sign in
        to Dash, create a gateway, then pair your phone by scanning its QR code. Leave this off to
        pair over your local network only.
      </p>

      {!status?.signedIn && (
        <button type="button" onClick={signIn} disabled={busy} className={btnPrimary}>
          {busy ? 'Opening browser…' : 'Sign in to Dash'}
        </button>
      )}

      {status?.signedIn && !status.enrolled && (
        <div className="flex items-center gap-3">
          <p data-testid="relay-signedin" className="text-xs text-green">
            Signed in to Dash
          </p>
          <button type="button" onClick={enroll} disabled={busy} className={btnPrimary}>
            {busy ? 'Creating…' : 'Create gateway'}
          </button>
        </div>
      )}

      {status?.signedIn && status.enrolled && (
        <div className="grid gap-3">
          <p data-testid="relay-status" className="text-xs text-green">
            Gateway ready at <span className="font-mono text-foreground">{status.subdomain}</span>
          </p>
          <div className="grid gap-2">
            <h3 className="text-[11px] uppercase tracking-[1px] text-muted">Paired devices</h3>
            {devices.length === 0 ? (
              <p className="text-xs text-muted">No devices paired yet.</p>
            ) : (
              <ul className="grid gap-1">
                {devices.map((d) => (
                  <li
                    key={d.id}
                    data-testid="device-row"
                    className="flex items-center justify-between rounded-lg border border-border px-3 py-1.5"
                  >
                    <span className="text-xs text-foreground">{d.label ?? d.id}</span>
                    <button
                      type="button"
                      aria-label={`Revoke ${d.label ?? d.id}`}
                      onClick={() => revoke(d.id)}
                      disabled={busy}
                      className={btnSecondary}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-red">{error}</p>}
    </div>
  );
}
