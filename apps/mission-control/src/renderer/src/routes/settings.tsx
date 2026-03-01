import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

function Settings(): JSX.Element {
  const [version, setVersion] = useState<string>('...');

  useEffect(() => {
    window.api.getVersion().then(setVersion);
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-2 text-muted">Application settings and configuration.</p>
      <div className="mt-6 rounded-lg border border-border bg-sidebar-bg p-4">
        <h2 className="text-sm font-semibold">About</h2>
        <p className="mt-2 text-sm text-muted">
          Mission Control v<span className="text-foreground">{version}</span>
        </p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings')({
  component: Settings,
});
