import { Lock } from 'lucide-react';

export function SandboxVisual() {
  const agents = [
    { dotColor: 'bg-success', name: 'Research Agent', status: 'Running' },
    { dotColor: 'bg-amber', name: 'Writer Agent', status: 'Processing' },
    { dotColor: 'bg-success', name: 'Analyst Agent', status: 'Running' },
  ];

  return (
    <div className="bg-white rounded-2xl shadow-lg p-8 flex flex-col gap-6">
      {/* Lock icon row */}
      <div className="flex items-center justify-center gap-3">
        <Lock size={32} className="text-text-dark" />
        <span className="font-outfit text-lg font-semibold text-text-dark">Secure Sandbox</span>
      </div>

      {/* Divider */}
      <div className="h-px w-full bg-cream-border" />

      {/* Agent status boxes */}
      <div className="flex flex-col gap-3">
        {agents.map((agent) => (
          <div key={agent.name} className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full ${agent.dotColor}`} />
            <span className="font-mono text-xs text-text-dark">{agent.name}</span>
            <span className="font-mono text-xs text-text-muted ml-auto">{agent.status}</span>
          </div>
        ))}
      </div>

      {/* Divider */}
      <div className="h-px w-full bg-cream-border" />

      {/* Footer */}
      <div className="flex items-center justify-center gap-2">
        <span className="w-2 h-2 rounded-full bg-success" />
        <span className="font-mono text-xs text-text-muted">All systems nominal</span>
      </div>
    </div>
  );
}
