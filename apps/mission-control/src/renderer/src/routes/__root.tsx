import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SetupWizard } from '../components/SetupWizard';
import { Sidebar } from '../components/Sidebar';
import { useAgentsStore } from '../stores/agents.js';
import { initChatListeners } from '../stores/chat';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout(): JSX.Element {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .setupStatus()
      .then((status) => {
        setNeedsSetup(status.needsSetup);
        setReady(!status.needsSetup);
        setChecking(false);
      })
      .catch(() => {
        setNeedsSetup(true);
        setChecking(false);
      });
  }, []);

  const loadAgents = useAgentsStore((s) => s.loadAgents);

  useEffect(() => {
    if (ready) {
      initChatListeners();
      loadAgents();
    }
  }, [ready, loadAgents]);

  // Reload agents when gateway emits agent config changes
  useEffect(() => {
    if (!ready) return;
    const unsub = window.api.onGatewayEvent((eventType) => {
      if (
        eventType === 'agent:config-changed' ||
        eventType === 'agent:registered' ||
        eventType === 'agent:removed'
      ) {
        loadAgents();
      }
    });
    return unsub;
  }, [ready, loadAgents]);

  useEffect(() => {
    return window.api.onUpdateAvailable((info) => {
      setUpdateVersion(info.version);
    });
  }, []);

  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!ready) {
    return <SetupWizard needsSetup={needsSetup} onComplete={() => setReady(true)} />;
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {updateVersion && (
        <div className="flex items-center justify-center bg-primary px-4 py-2 text-sm text-primary-foreground">
          A new version ({updateVersion}) is available and will be installed on next restart.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="min-w-0 flex flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
