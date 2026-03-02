import { Link, createFileRoute } from '@tanstack/react-router';
import { Bot, Circle, Loader, Plus } from 'lucide-react';
import { useEffect } from 'react';
import { useDeploymentsStore } from '../stores/deployments';

function Dashboard(): JSX.Element {
  const { deployments, loading, loadDeployments } = useDeploymentsStore();

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  const running = deployments.filter((d) => d.status === 'running').length;
  const stopped = deployments.filter((d) => d.status === 'stopped').length;
  const errored = deployments.filter((d) => d.status === 'error').length;

  if (loading && deployments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">Overview of your Dash agents and deployments.</p>
        </div>
        <Link
          to="/deploy"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
        >
          <Plus size={16} />
          Deploy New Agent
        </Link>
      </div>

      <div className="mb-8 grid grid-cols-3 gap-4">
        <StatCard label="Total Agents" value={deployments.length} />
        <StatCard label="Running" value={running} color="text-green-400" />
        <StatCard
          label={errored > 0 ? 'Stopped / Error' : 'Stopped'}
          value={errored > 0 ? `${stopped} / ${errored}` : stopped}
          color={errored > 0 ? 'text-red-400' : 'text-muted'}
        />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold">Recent Deployments</h2>
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
            {deployments.slice(0, 5).map((deployment, i) => (
              <Link
                key={deployment.id}
                to="/agents/$id"
                params={{ id: deployment.id }}
                className={`flex items-center justify-between px-4 py-3 transition-colors hover:bg-sidebar-hover ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <StatusDot status={deployment.status} />
                  <div>
                    <span className="text-sm font-medium">{deployment.name}</span>
                    <span className="ml-2 text-xs text-muted">{deployment.id}</span>
                  </div>
                </div>
                <span className="text-xs text-muted">
                  {new Date(deployment.createdAt).toLocaleDateString()}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: { label: string; value: number | string; color?: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-sidebar-bg p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color ?? 'text-foreground'}`}>{value}</p>
    </div>
  );
}

function StatusDot({ status }: { status: string }): JSX.Element {
  const color =
    status === 'running' ? 'text-green-400' : status === 'error' ? 'text-red-400' : 'text-muted';
  return <Circle size={8} className={`fill-current ${color}`} />;
}

export const Route = createFileRoute('/')({
  component: Dashboard,
});
