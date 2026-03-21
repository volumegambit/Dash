import type { MessagingApp } from '@dash/mc';
import { Link, createFileRoute } from '@tanstack/react-router';
import { MessageSquare, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { useMessagingAppsStore } from '../../stores/messaging-apps.js';

function PlatformIcon({ type }: { type: string }): JSX.Element {
  if (type === 'whatsapp') {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[#25D366]">
        <path
          d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.956 9.956 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"
          fill="currentColor"
          fillOpacity="0.2"
        />
        <path
          d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"
          fill="currentColor"
        />
      </svg>
    );
  }
  // Telegram
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[#229ED9]">
      <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.2" />
      <path
        d="M17.5 7L10 13.5 7 12l10.5-5zM10 13.5l.8 3.5 2-2.2-2.8-1.3z"
        fill="currentColor"
      />
    </svg>
  );
}

function MessagingApps(): JSX.Element {
  const { apps, loading, loadApps } = useMessagingAppsStore();

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold font-[family-name:var(--font-display)]">
          Messaging Apps
        </h1>
        <div className="flex items-center gap-2">
          <Link
            to="/messaging-apps/new-telegram"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
          >
            <Plus size={16} />
            Add Telegram
          </Link>
          <Link
            to="/messaging-apps/new-whatsapp"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:opacity-90"
          >
            <Plus size={16} />
            Connect App
          </Link>
        </div>
      </div>

      {/* Body */}
      <div className="p-8 bg-card-bg border border-border rounded-lg">
        {/* Section label */}
        <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent mb-4">
          Connected Platforms
        </p>

        {apps.length === 0 && !loading ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center">
            <MessageSquare size={24} className="mx-auto mb-2 text-muted" />
            <p className="text-sm font-medium">No messaging apps connected yet</p>
            <p className="mt-1 text-sm text-muted">
              Connect Telegram or WhatsApp so people can message your AI assistant directly.
            </p>
            <div className="mt-3 flex items-center justify-center gap-3">
              <Link
                to="/messaging-apps/new-telegram"
                className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
              >
                <Plus size={14} />
                Add Telegram
              </Link>
              <span className="text-muted">·</span>
              <Link
                to="/messaging-apps/new-whatsapp"
                className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
              >
                <Plus size={14} />
                Add WhatsApp
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {apps.map((app) => (
              <AppCard key={app.id} app={app} agentCount={app.routing.length} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AppCard({
  app,
  agentCount,
}: {
  app: MessagingApp;
  agentCount: number;
}): JSX.Element {
  const isConnected = app.enabled;

  return (
    <Link
      to="/messaging-apps/$id"
      params={{ id: app.id }}
      className="bg-card-bg border border-border p-5 flex flex-col gap-3 hover:bg-card-hover transition-colors cursor-pointer rounded-lg"
    >
      {/* Header row */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <PlatformIcon type={app.type} />
          <span className="font-semibold text-[16px] text-foreground capitalize">{app.type}</span>
        </div>
        {isConnected ? (
          <span className="bg-green-tint text-green rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
            Connected
          </span>
        ) : (
          <span className="bg-red-tint text-red rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
            Not Connected
          </span>
        )}
      </div>

      {/* Agent count */}
      <p className="text-xs text-muted">
        {agentCount} agent{agentCount !== 1 ? 's' : ''} connected
      </p>

      {/* Configure link */}
      <span className="text-accent text-xs hover:underline">Configure →</span>
    </Link>
  );
}

export const Route = createFileRoute('/messaging-apps/')({
  component: MessagingApps,
});
