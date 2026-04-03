import type { GatewayAgent } from '@dash/mc';

interface AgentMonitorTabProps {
  agent: GatewayAgent;
}

export function AgentMonitorTab({ agent }: AgentMonitorTabProps): JSX.Element {
  return (
    <div className="flex min-h-48 flex-1 flex-col">
      {/* Runtime info */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
        <span>
          <span className="text-muted">Status</span>{' '}
          <span className="font-medium">{agent.status}</span>
        </span>
        <span>
          <span className="text-muted">Registered</span>{' '}
          <span className="font-medium">
            {new Date(agent.registeredAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
            {', '}
            {new Date(agent.registeredAt).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              timeZoneName: 'short',
            })}
          </span>
        </span>
      </div>

      <div className="rounded-lg border border-border bg-card-bg p-3 font-[family-name:var(--font-mono)] text-xs leading-5">
        <p className="text-muted">
          Agent logs are managed by the gateway. Check gateway logs for runtime details.
        </p>
      </div>
    </div>
  );
}
