import type { GatewayAgent } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { Bot, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { McpConnectorInfo } from '../../../../shared/ipc.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useConnectorsStore } from '../../stores/connectors.js';

function truncateModel(model: string): string {
  const parts = model.split('/');
  const name = parts[parts.length - 1] ?? model;
  return name.length > 24 ? `${name.slice(0, 22)}…` : name;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function mcpIssueText(
  agent: GatewayAgent,
  connectors: McpConnectorInfo[],
): string | null {
  const mcpNames = agent.config.mcpServers ?? [];
  if (mcpNames.length === 0) return null;

  for (const name of mcpNames) {
    const connector = connectors.find((c) => c.name === name);
    if (!connector) continue;
    if (connector.status === 'needs_reauth') return `${name} needs re-authorization`;
    if (connector.status === 'error') return `${name} connector offline`;
    if (connector.status === 'disconnected') return `${name} connector disconnected`;
  }
  return null;
}

function statusDotColor(
  agent: GatewayAgent,
  connectors: McpConnectorInfo[],
): string {
  const isActive = agent.status === 'active' || agent.status === 'registered';
  if (isActive && mcpIssueText(agent, connectors)) return 'bg-yellow';
  if (isActive) return 'bg-green';
  return 'bg-red'; // disabled
}

function Agents(): JSX.Element {
  const { agents, loading, loadAgents, removeAgent } = useAgentsStore();
  const connectors = useConnectorsStore((s) => s.connectors);
  const loadConnectors = useConnectorsStore((s) => s.loadConnectors);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    loadAgents();
    loadConnectors();
  }, [loadAgents, loadConnectors]);

  useEffect(() => {
    const unsub = useConnectorsStore.getState().initConnectorListeners();
    return unsub;
  }, []);

  const filtered = agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex justify-between items-center flex-shrink-0">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          Agents
        </h1>
        <div className="flex gap-3 items-center">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              placeholder="Search Agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 bg-card-bg border border-border pl-9 pr-3 py-2 rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
            />
          </div>
          <Link
            to="/deploy"
            className="bg-accent text-white px-4 py-2 flex items-center gap-2 font-semibold text-[13px] hover:bg-primary-hover transition-colors"
          >
            <Plus size={16} /> Deploy Agent
          </Link>
        </div>
      </div>

      {/* Body */}
      <div className="p-8 flex flex-col gap-4 flex-1 overflow-y-auto">
        {loading && agents.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex gap-1.5 items-center text-muted text-sm">
              <span className="animate-bounce [animation-delay:0ms]">•</span>
              <span className="animate-bounce [animation-delay:150ms]">•</span>
              <span className="animate-bounce [animation-delay:300ms]">•</span>
            </div>
          </div>
        ) : agents.length === 0 ? (
          <div className="border border-border bg-card-bg p-8 text-center">
            <Bot size={24} className="mx-auto mb-2 text-muted" />
            <p className="text-sm text-muted">No agents deployed yet.</p>
            <Link
              to="/deploy"
              className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:text-primary-hover"
            >
              <Plus size={14} />
              Deploy your first agent
            </Link>
          </div>
        ) : (
          <>
            <span className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[2px] text-accent">
              DEPLOYED AGENTS
            </span>

            <div className="bg-card-bg border border-border overflow-hidden">
              {/* Table header */}
              <div className="bg-surface border-b border-border flex items-center px-5 py-3">
                <span className="w-16 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                  STATUS
                </span>
                <span className="flex-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                  NAME
                </span>
                <span className="w-48 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                  MODEL
                </span>
                <span className="w-20 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                  TOOLS
                </span>
                <span className="w-28 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                  REGISTERED
                </span>
                {/* actions column spacer */}
                <span className="w-16" />
              </div>

              {/* Table rows */}
              {filtered.length === 0 ? (
                <div className="px-5 py-6 text-center text-sm text-muted">
                  No agents match your search.
                </div>
              ) : (
                filtered.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    connectors={connectors}
                    onNavigate={() =>
                      navigate({ to: '/agents/$id', params: { id: agent.id } })
                    }
                    onRemove={() => {
                      setRemoveTarget({
                        id: agent.id,
                        name: agent.name,
                      });
                    }}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* Remove confirmation modal */}
      {removeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm border border-border bg-card-bg p-6 shadow-lg">
            <h2 className="text-base font-semibold font-[family-name:var(--font-display)]">
              Remove {removeTarget.name}?
            </h2>
            <p className="mt-1 text-sm text-muted">
              This will remove the agent from the gateway.
            </p>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                className="border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { id } = removeTarget;
                  setRemoveTarget(null);
                  await removeAgent(id);
                }}
                className="bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AgentRowProps {
  agent: GatewayAgent;
  connectors: McpConnectorInfo[];
  onNavigate(): void;
  onRemove(): void;
}

function AgentRow({ agent, connectors, onNavigate, onRemove }: AgentRowProps): JSX.Element {
  const toolCount = agent.config.tools?.length ?? 0;
  const model = agent.config.model;
  const isActive = agent.status === 'active' || agent.status === 'registered';

  return (
    <button
      type="button"
      className="w-full border-b border-border flex items-center px-5 py-3.5 hover:bg-card-hover cursor-pointer transition-colors group last:border-b-0 text-left"
      onClick={onNavigate}
    >
      {/* Status */}
      <div className="w-16 flex items-center">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotColor(agent, connectors)}`}
          title={agent.status}
        />
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0 text-left">
        <span className="font-[family-name:var(--font-display)] font-semibold text-sm text-foreground">
          {agent.name}
        </span>
        {isActive && mcpIssueText(agent, connectors) && (
          <p className="text-xs text-yellow-400 mt-0.5">
            {mcpIssueText(agent, connectors)}
          </p>
        )}
      </div>

      {/* Model */}
      <div className="w-48 text-left">
        <span className="font-[family-name:var(--font-mono)] text-xs text-muted">
          {truncateModel(model)}
        </span>
      </div>

      {/* Tools */}
      <div className="w-20">
        <span className="bg-accent-tint text-accent text-xs px-2 py-0.5 rounded font-semibold">
          {toolCount}
        </span>
      </div>

      {/* Registered */}
      <div className="w-28">
        <span className="text-xs text-muted">{relativeTime(agent.registeredAt)}</span>
      </div>

      {/* Actions — visible on row hover */}
      <div
        className="w-16 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <button
          type="button"
          onClick={onRemove}
          title="Remove"
          className="p-1.5 text-muted transition-colors hover:bg-red-900/30 hover:text-red rounded"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </button>
  );
}

export const Route = createFileRoute('/agents/')({
  component: Agents,
});
