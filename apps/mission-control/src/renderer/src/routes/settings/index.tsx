import { createFileRoute } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { SquadPicker } from '../../companion/pets/SquadPicker.js';
import { useUIStore } from '../../stores/ui.js';

export function GeneralSettings(): JSX.Element {
  const [version, setVersion] = useState<string>('...');
  const [restarting, setRestarting] = useState(false);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const companionVisible = useUIStore((s) => s.companionVisible);
  const setCompanionVisible = useUIStore((s) => s.setCompanionVisible);
  const companionSelection = useUIStore((s) => s.companionSelection);
  const setCompanionSelection = useUIStore((s) => s.setCompanionSelection);

  useEffect(() => {
    window.api.getVersion().then(setVersion);
  }, []);

  const handleRestartGateway = useCallback(async () => {
    setRestarting(true);
    setRestartStatus('idle');
    try {
      await window.api.gatewayRestart();
      setRestartStatus('success');
      setTimeout(() => setRestartStatus('idle'), 3000);
    } catch {
      setRestartStatus('error');
      setTimeout(() => setRestartStatus('idle'), 5000);
    } finally {
      setRestarting(false);
    }
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="bg-surface px-8 py-4 border-b border-border shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          General
        </h1>
        <p className="mt-1 text-sm text-muted">Application, gateway, and squad settings.</p>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="rounded-lg border border-border bg-card-bg p-4">
          <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            Gateway
          </h2>
          <p className="mb-3 text-xs text-muted">
            The gateway process manages agents, channels, and credentials.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRestartGateway}
              disabled={restarting}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={restarting ? 'animate-spin' : ''} />
              {restarting ? 'Restarting...' : 'Restart Gateway'}
            </button>
            {restartStatus === 'success' && (
              <span className="text-xs text-green">Gateway restarted successfully</span>
            )}
            {restartStatus === 'error' && (
              <span className="text-xs text-red">Failed to restart gateway</span>
            )}
          </div>
        </div>

        <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
          <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            Squad
          </h2>
          <p className="mb-3 text-xs text-muted">
            Your squad floats on your desktop and shows which sessions are working, need you, or
            finished while you were away. One member appears per running agent, each with a speech
            bubble of what it's doing.
          </p>
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={companionVisible}
              onChange={(e) => setCompanionVisible(e.target.checked)}
              className="rounded border border-border"
            />
            <span className="text-xs font-medium text-foreground">Show the squad</span>
          </label>
          {companionVisible && (
            <SquadPicker value={companionSelection} onChange={setCompanionSelection} />
          )}
        </div>

        <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
          <h2 className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            About
          </h2>
          <p className="mt-2 text-sm text-muted">
            DashSquad v<span className="text-foreground">{version}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings/')({
  component: GeneralSettings,
});
