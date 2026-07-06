import { Cloud, Server, Settings2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GatewayConnectionStatus } from '../../../shared/ipc.js';
import { GatewayConnectionWizard } from './GatewayConnectionWizard.js';

function statusLabel(status: GatewayConnectionStatus | null): string {
  if (!status) return 'Checking...';
  if (status.profile.mode === 'local') return 'This computer';
  return status.profile.name || 'Existing gateway';
}

function statusText(status: GatewayConnectionStatus | null): string {
  if (!status) return 'Checking...';
  return `${statusLabel(status)} - ${status.health}`;
}

export function GatewayRuntimeSettings(): JSX.Element {
  const [status, setStatus] = useState<GatewayConnectionStatus | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [busy, setBusy] = useState<'local' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await window.api.gatewayConnectionGet();
    setStatus(next);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const currentMode = status?.profile.mode ?? 'local';
  const currentEndpoint = useMemo(() => {
    if (currentMode === 'local') return '127.0.0.1';
    return status?.profile.managementBaseUrl || 'Remote gateway';
  }, [currentMode, status]);

  const button =
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted transition hover:bg-card-hover hover:text-foreground disabled:opacity-50';
  const primary =
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50';

  const useLocal = async (): Promise<void> => {
    setBusy('local');
    setError(null);
    try {
      setStatus(await window.api.gatewayConnectionUseLocal());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gateway update failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {currentMode === 'local' ? <Server size={15} /> : <Cloud size={15} />}
            <span data-testid="gateway-runtime-status" className="text-sm font-medium">
              {statusText(status)}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted">{currentEndpoint}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {currentMode !== 'local' && (
            <button type="button" onClick={useLocal} disabled={busy !== null} className={button}>
              <Unplug size={14} />
              Use this computer
            </button>
          )}
          <button type="button" onClick={() => setShowWizard(true)} className={primary}>
            <Settings2 size={14} />
            Change gateway
          </button>
        </div>
      </div>

      {showWizard && (
        <GatewayConnectionWizard
          onConnected={(nextStatus) => {
            setStatus(nextStatus);
            setShowWizard(false);
          }}
          onCancel={() => setShowWizard(false)}
        />
      )}

      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
