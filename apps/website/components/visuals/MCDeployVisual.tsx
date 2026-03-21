import { LayoutDashboard, Rocket, MessageSquare, Settings } from 'lucide-react';

export function MCDeployVisual() {
  return (
    <div className="rounded-xl bg-command border border-surface-border shadow-lg overflow-hidden w-full">
      {/* Title bar */}
      <div className="bg-surface flex items-center gap-2 py-2.5 px-3.5 border-b border-surface-border">
        <span className="w-2.5 h-2.5 rounded-full bg-[#f87171]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#facc15]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#4ade80]" />
        <span className="font-mono text-xs text-text-muted ml-2">Mission Control</span>
      </div>

      {/* Body */}
      <div className="flex" style={{ height: '300px' }}>
        {/* Sidebar */}
        <div className="w-14 bg-surface border-r border-surface-border py-4 flex flex-col items-center gap-4">
          <LayoutDashboard size={20} className="text-text-secondary" />
          <Rocket size={20} className="text-brand" />
          <MessageSquare size={20} className="text-text-secondary" />
          <Settings size={20} className="text-text-secondary" />
        </div>

        {/* Main area */}
        <div className="flex-1 p-6 flex flex-col gap-4">
          <span className="font-outfit text-sm font-semibold text-white">Deploy New Agent</span>

          {/* Agent Name field */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">Agent Name</span>
            <div className="h-8 bg-surface border border-surface-border rounded px-3 flex items-center">
              <span className="text-xs text-text-secondary">Research Assistant</span>
            </div>
          </div>

          {/* Model field */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">Model</span>
            <div className="h-8 bg-surface border border-surface-border rounded px-3 flex items-center">
              <span className="text-xs text-text-secondary">Claude 3.5 Sonnet</span>
            </div>
          </div>

          {/* Tools field */}
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">Tools</span>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-brand/20 border border-brand px-2 py-1 text-[10px] text-brand">
                Web Search
              </span>
              <span className="rounded-full bg-brand/20 border border-brand px-2 py-1 text-[10px] text-brand">
                File Read
              </span>
              <span className="rounded-full bg-surface border border-surface-border px-2 py-1 text-[10px] text-text-muted">
                Code Exec
              </span>
            </div>
          </div>

          {/* Deploy button */}
          <button className="w-full bg-brand text-white text-xs font-semibold py-2 rounded flex items-center justify-center gap-1.5 mt-auto">
            <Rocket size={12} />
            Deploy Agent
          </button>
        </div>
      </div>
    </div>
  );
}
