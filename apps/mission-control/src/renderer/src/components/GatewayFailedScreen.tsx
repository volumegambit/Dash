import { ArrowRight, Loader, Pencil, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayConnectionStatus } from '../../../shared/ipc.js';
import { DashSquadMark } from './DashSquadLogo.js';
import { GatewayConnectionWizard } from './GatewayConnectionWizard.js';

/**
 * Shown when the user has completed setup but the gateway cannot start.
 * Distinct from the onboarding wizard: this is a runtime failure, not a
 * first run. Local failures can be retried; remote failures can be edited or
 * moved back to the local gateway without exposing config files.
 */
export function GatewayFailedScreen({ onRecovered }: { onRecovered: () => void }): JSX.Element {
  const [retrying, setRetrying] = useState(false);
  const [switchingLocal, setSwitchingLocal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<GatewayConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .gatewayConnectionGet()
      .then(setConnectionStatus)
      .catch(() => {});
  }, []);

  const savedRemoteGateway = Boolean(connectionStatus && connectionStatus.profile.mode !== 'local');

  const handleRetry = async (): Promise<void> => {
    setRetrying(true);
    setError(null);
    try {
      if (savedRemoteGateway) {
        const next = await window.api.gatewayConnectionGet();
        setConnectionStatus(next);
        if (next.health !== 'healthy') {
          throw new Error('Gateway is still unreachable');
        }
      } else {
        await window.api.setupEnsureGateway();
      }
      onRecovered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRetrying(false);
    }
  };

  const handleUseLocal = async (): Promise<void> => {
    setSwitchingLocal(true);
    setError(null);
    try {
      await window.api.gatewayConnectionUseLocal();
      onRecovered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSwitchingLocal(false);
    }
  };

  if (editing) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4 text-foreground">
        <div className="w-full max-w-2xl rounded-lg border border-border bg-card-bg p-5">
          <GatewayConnectionWizard onConnected={onRecovered} onCancel={() => setEditing(false)} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md px-4 text-center">
        <div className="mb-6 flex justify-center">
          <DashSquadMark size={48} />
        </div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight">
          {savedRemoteGateway ? 'Saved gateway is not reachable' : 'Gateway failed to start'}
        </h1>
        <p className="mt-3 text-sm text-muted">
          {savedRemoteGateway
            ? 'A saved gateway is not reachable. Choose another gateway connection to continue.'
            : "Dash couldn't start its background service. Check the logs for details."}
        </p>
        {error && <p className="mt-2 text-sm text-red">{error}</p>}
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying || switchingLocal}
          className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {retrying ? (
            <Loader size={16} className="animate-spin" />
          ) : (
            <>
              Retry
              <ArrowRight size={16} />
            </>
          )}
        </button>
        {savedRemoteGateway && (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={retrying || switchingLocal}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-6 py-3 text-sm font-medium text-muted transition-colors hover:text-foreground disabled:opacity-60"
            >
              <Pencil size={16} />
              Edit gateway connection
            </button>
            <button
              type="button"
              onClick={handleUseLocal}
              disabled={retrying || switchingLocal}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-6 py-3 text-sm font-medium text-muted transition-colors hover:text-foreground disabled:opacity-60"
            >
              {switchingLocal ? (
                <Loader size={16} className="animate-spin" />
              ) : (
                <Server size={16} />
              )}
              Use this computer
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            window.api.appQuit().catch(() => {});
          }}
          className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-border px-6 py-3 text-sm font-medium text-muted transition-colors hover:text-foreground"
        >
          Quit
        </button>
      </div>
    </div>
  );
}
