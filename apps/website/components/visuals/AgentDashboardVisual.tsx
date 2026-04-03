const AGENTS = [
  { dot: 'bg-success', name: 'Research Agent', status: 'Active' },
  { dot: 'bg-amber', name: 'Writer Agent', status: 'Processing' },
  { dot: 'bg-success', name: 'Analyst Agent', status: 'Active' },
];

export function AgentDashboardVisual() {
  return (
    <div className="bg-surface p-5 flex flex-col justify-center gap-3 w-[280px] h-[160px]">
      {AGENTS.map((agent) => (
        <div key={agent.name} className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${agent.dot}`} />
          <span className="font-mono text-xs text-text-primary">{agent.name}</span>
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-text-muted">{agent.status}</span>
        </div>
      ))}
    </div>
  );
}
