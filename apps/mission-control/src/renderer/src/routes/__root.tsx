import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SetupWizard } from '../components/SetupWizard';
import { Sidebar } from '../components/Sidebar';
import { initChatListeners } from '../stores/chat';
import { initDeploymentListeners } from '../stores/deployments';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout(): JSX.Element {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [needsApiKey, setNeedsApiKey] = useState(false);

  useEffect(() => {
    window.api
      .setupGetStatus()
      .then((status) => {
        setNeedsSetup(status.needsSetup);
        setNeedsApiKey(status.needsApiKey);
        setReady(!status.needsSetup && !status.needsApiKey);
        setChecking(false);
      })
      .catch(() => {
        // If IPC fails (e.g. store not ready), fall through to setup wizard
        setNeedsSetup(true);
        setNeedsApiKey(true);
        setChecking(false);
      });
  }, []);

  useEffect(() => {
    if (ready) {
      initDeploymentListeners();
      initChatListeners();
    }
  }, [ready]);

  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!ready) {
    return (
      <SetupWizard
        needsSetup={needsSetup}
        needsApiKey={needsApiKey}
        onComplete={() => setReady(true)}
      />
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
