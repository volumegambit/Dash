import type { AgentDeployment, RuntimeStatus } from '@dash/mc';
import type { MessagingApp } from '@dash/mc';
import { Link } from '@tanstack/react-router';
import type { ChannelHealthEntry } from '../../../../../shared/ipc.js';
import { HealthDot } from '../../../components/HealthDot.js';

interface AgentOverviewTabProps {
  deployment: AgentDeployment;
  status: RuntimeStatus | null;
  channelHealth: ChannelHealthEntry[];
  apps: MessagingApp[];
}

export function AgentOverviewTab({
  deployment,
  status,
  channelHealth,
  apps,
}: AgentOverviewTabProps): JSX.Element {
  return (
    <div className="space-y-6">
      {/* Runtime details grid */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-sidebar-bg p-4">
          <p className="text-xs text-muted">PID</p>
          <p className="mt-1 text-sm font-medium">
            {status?.agentServerPid ?? deployment.agentServerPid ?? 'N/A'}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-sidebar-bg p-4">
          <p className="text-xs text-muted">Chat Port</p>
          <p className="mt-1 text-sm font-medium">
            {status?.chatPort ?? deployment.chatPort ?? 'N/A'}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-sidebar-bg p-4">
          <p className="text-xs text-muted">Management Port</p>
          <p className="mt-1 text-sm font-medium">
            {status?.managementPort ?? deployment.managementPort ?? 'N/A'}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-sidebar-bg p-4">
          <p className="text-xs text-muted">Created</p>
          <p className="mt-1 text-sm font-medium">
            {new Date(deployment.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Channel connections list */}
      {channelHealth.length > 0 && (
        <div className="rounded-lg border border-border bg-sidebar-bg p-4">
          <h3 className="mb-3 text-sm font-medium text-muted">Channel Connections</h3>
          <div className="space-y-2">
            {channelHealth.map((entry) => {
              const app = apps.find((a) => a.id === entry.appId);
              const needsAction =
                entry.health === 'needs_reauth' || entry.health === 'disconnected';
              return (
                <div key={entry.appId} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <HealthDot health={entry.health} />
                    <span className="text-foreground">{app?.name ?? entry.appId}</span>
                    <span className="text-xs text-muted capitalize">{entry.type}</span>
                  </div>
                  {needsAction && (
                    <Link
                      to="/messaging-apps/$id"
                      params={{ id: entry.appId }}
                      className="text-xs text-primary hover:underline"
                    >
                      Re-connect &rarr;
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
