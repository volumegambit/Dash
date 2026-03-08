import type { MessagingApp } from '@dash/mc';
import { Link, createFileRoute } from '@tanstack/react-router';
import { MessageSquare, Plus, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMessagingAppsStore } from '../../stores/messaging-apps';

function MessagingApps(): JSX.Element {
  const { apps, loading, loadApps, deleteApp, updateApp } = useMessagingAppsStore();
  const [deleteTarget, setDeleteTarget] = useState<MessagingApp | null>(null);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Messaging Apps</h1>
          <p className="mt-1 text-sm text-muted">
            Connect messaging platforms so people can talk to your AI assistants.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/messaging-apps/new-telegram"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
          >
            <Plus size={16} />
            Add Telegram
          </Link>
          <Link
            to="/messaging-apps/new-whatsapp"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
          >
            <Plus size={16} />
            Add WhatsApp
          </Link>
        </div>
      </div>

      {apps.length === 0 && !loading ? (
        <div className="rounded-lg border border-border bg-sidebar-bg p-8 text-center">
          <MessageSquare size={24} className="mx-auto mb-2 text-muted" />
          <p className="text-sm font-medium">No messaging apps connected yet</p>
          <p className="mt-1 text-sm text-muted">
            Connect Telegram or WhatsApp so people can message your AI assistant directly.
          </p>
          <div className="mt-3 flex items-center justify-center gap-3">
            <Link
              to="/messaging-apps/new-telegram"
              className="inline-flex items-center gap-1 text-sm text-primary hover:text-primary-hover"
            >
              <Plus size={14} />
              Add Telegram
            </Link>
            <span className="text-muted">·</span>
            <Link
              to="/messaging-apps/new-whatsapp"
              className="inline-flex items-center gap-1 text-sm text-primary hover:text-primary-hover"
            >
              <Plus size={14} />
              Add WhatsApp
            </Link>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          {apps.map((app, i) => (
            <div
              key={app.id}
              className={`flex items-center justify-between px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
            >
              <Link
                to="/messaging-apps/$id"
                params={{ id: app.id }}
                className="flex flex-1 items-center gap-3 transition-colors hover:text-primary"
              >
                <span className="text-lg">{app.type === 'whatsapp' ? '📱' : '✈️'}</span>
                <div>
                  <span className="text-sm font-medium">{app.name}</span>
                  <span className="ml-2 text-xs text-muted capitalize">{app.type}</span>
                </div>
              </Link>

              <div className="flex items-center gap-3">
                <span className="text-xs text-muted">
                  {app.routing.length} rule{app.routing.length !== 1 ? 's' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => updateApp(app.id, { enabled: !app.enabled })}
                  title={app.enabled ? 'Disable' : 'Enable'}
                  className="text-muted transition-colors hover:text-foreground"
                >
                  {app.enabled ? (
                    <ToggleRight size={20} className="text-green-400" />
                  ) : (
                    <ToggleLeft size={20} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(app)}
                  title="Delete"
                  className="rounded p-1.5 text-muted transition-colors hover:bg-red-900/30 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-border bg-sidebar-bg p-6 shadow-lg">
            <h2 className="text-base font-semibold">Delete "{deleteTarget.name}"?</h2>
            <p className="mt-1 text-sm text-muted">
              This will disconnect the {deleteTarget.type} bot and remove all its routing rules.
              People will no longer be able to message your assistant through it.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { id } = deleteTarget;
                  setDeleteTarget(null);
                  await deleteApp(id);
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/')({
  component: MessagingApps,
});
