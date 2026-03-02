import { Link, createFileRoute } from '@tanstack/react-router';
import { Bot, Circle, Loader, Plus, Square, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';

function Agents(): JSX.Element {
  const { deployments, loading, loadDeployments, stop, remove } = useDeploymentsStore();

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  if (loading && deployments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="mt-1 text-sm text-muted">Manage your deployed Dash agents.</p>
        </div>
        <Link
          to="/deploy"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
        >
          <Plus size={16} />
          Deploy
        </Link>
      </div>

      {deployments.length === 0 ? (
        <div className="rounded-lg border border-border bg-sidebar-bg p-8 text-center">
          <Bot size={24} className="mx-auto mb-2 text-muted" />
          <p className="text-sm text-muted">No agents deployed yet.</p>
          <Link
            to="/deploy"
            className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:text-primary-hover"
          >
            <Plus size={14} />
            Deploy your first agent
          </Link>
        </div>
      ) : (
        <div className="rounded-lg border border-border">
          {deployments.map((deployment, i) => (
            <div
              key={deployment.id}
              className={`flex items-center justify-between px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
            >
              <Link
                to="/agents/$id"
                params={{ id: deployment.id }}
                className="flex flex-1 items-center gap-3 transition-colors hover:text-primary"
              >
                <StatusDot status={deployment.status} />
                <div>
                  <span className="text-sm font-medium">{deployment.name}</span>
                  <span className="ml-2 text-xs text-muted">{deployment.id}</span>
                </div>
              </Link>
              <div className="flex items-center gap-3">
                <StatusBadge status={deployment.status} />
                <span className="text-xs text-muted">
                  {new Date(deployment.createdAt).toLocaleDateString()}
                </span>
                <div className="flex items-center gap-1">
                  {deployment.status === 'running' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        stop(deployment.id);
                      }}
                      title="Stop"
                      className="rounded p-1.5 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
                    >
                      <Square size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(deployment.id);
                    }}
                    title="Remove"
                    className="rounded p-1.5 text-muted transition-colors hover:bg-red-900/30 hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }): JSX.Element {
  const color =
    status === 'running' ? 'text-green-400' : status === 'error' ? 'text-red-400' : 'text-muted';
  return <Circle size={8} className={`fill-current ${color}`} />;
}

function StatusBadge({ status }: { status: string }): JSX.Element {
  const styles =
    status === 'running'
      ? 'bg-green-900/30 text-green-400'
      : status === 'error'
        ? 'bg-red-900/30 text-red-400'
        : 'bg-sidebar-hover text-muted';
  return <span className={`rounded px-2 py-0.5 text-xs ${styles}`}>{status}</span>;
}

export const Route = createFileRoute('/agents/')({
  component: Agents,
});
