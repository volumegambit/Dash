import { Outlet, createRootRoute } from '@tanstack/react-router';
import { Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SetupWizard } from '../components/SetupWizard';
import { Sidebar } from '../components/Sidebar';
import { initChatListeners } from '../stores/chat';
import { initDeploymentListeners, useDeploymentsStore } from '../stores/deployments';
import { useMessagingAppsStore } from '../stores/messaging-apps.js';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout(): JSX.Element {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  const deployments = useDeploymentsStore((s) => s.deployments);
  const pollHealth = useMessagingAppsStore((s) => s.pollHealth);

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

  useEffect(() => {
    return window.api.onUpdateAvailable((info) => {
      setUpdateVersion(info.version);
    });
  }, []);

  useEffect(() => {
    const running = deployments.filter((d) => d.status === 'running');
    if (running.length === 0) return;

    const deploymentId = running[0].id; // v1: one deployment
    void pollHealth(deploymentId); // immediate poll
    const interval = setInterval(() => void pollHealth(deploymentId), 5000);
    return () => clearInterval(interval);
  }, [deployments, pollHealth]);

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
    <div className="flex h-screen flex-col bg-background text-foreground">
      {updateVersion && (
        <div className="flex items-center justify-center bg-primary px-4 py-2 text-sm text-primary-foreground">
          A new version ({updateVersion}) is available and will be installed on next restart.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex flex-1 flex-col overflow-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
