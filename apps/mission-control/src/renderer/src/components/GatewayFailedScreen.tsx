import { ArrowRight, Loader } from 'lucide-react';
import { useState } from 'react';
import { DashSquadMark } from './DashSquadLogo.js';

/**
 * Shown when the user has completed setup but the gateway cannot start.
 * Distinct from the onboarding wizard: this is a runtime failure, not a
 * first run. Retry re-attempts the spawn (and wires the chat service via
 * setupEnsureGateway); Quit exits the app.
 */
export function GatewayFailedScreen({ onRecovered }: { onRecovered: () => void }): JSX.Element {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRetry = async (): Promise<void> => {
    setRetrying(true);
    setError(null);
    try {
      await window.api.setupEnsureGateway();
      onRecovered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRetrying(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md px-4 text-center">
        <div className="mb-6 flex justify-center">
          <DashSquadMark size={48} />
        </div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight">
          Gateway failed to start
        </h1>
        <p className="mt-3 text-sm text-muted">
          Dash couldn&apos;t start its background service. Check the logs for details.
        </p>
        {error && <p className="mt-2 text-sm text-red">{error}</p>}
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
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
