import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GatewayFailedScreen } from '../components/GatewayFailedScreen';
import { SetupWizard } from '../components/SetupWizard';
import { Sidebar } from '../components/Sidebar';
import { useAgentsStore } from '../stores/agents.js';
import { initChatListeners } from '../stores/chat';
import { useUIStore } from '../stores/ui.js';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout(): JSX.Element {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [setupState, setSetupState] = useState<'needs-setup' | 'ready' | 'gateway-failed'>(
    'needs-setup',
  );
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .setupStatus()
      .then((status) => {
        setSetupState(status.state);
        setReady(status.state === 'ready');
        setChecking(false);
      })
      .catch(() => {
        setSetupState('needs-setup');
        setReady(false);
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

  // Keyboard shortcut: Cmd+B / Ctrl+B to toggle sidebar
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSidebar]);

  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!ready) {
    if (setupState === 'gateway-failed') {
      return (
        <GatewayFailedScreen
          onRecovered={() => {
            setSetupState('ready');
            setReady(true);
          }}
        />
      );
    }
    return <SetupWizard needsSetup={true} onComplete={() => setReady(true)} />;
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
