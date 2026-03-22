import type { AgentDeployment } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { Bot, Plus, Search, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RuntimeAgentConfig } from '../../../../shared/ipc.js';
import { useAgentConfigsStore } from '../../stores/agent-configs.js';
import { useDeploymentsStore } from '../../stores/deployments';

function getModel(configs: Record<string, RuntimeAgentConfig>, deployment: AgentDeployment): string {
  const cfg = configs[deployment.name];
  return cfg?.model ?? '—';
}

function truncateModel(model: string): string {
  // Strip provider prefix like "anthropic/claude-3-5-sonnet-20241022" → "claude-3-5-sonnet..."
  const parts = model.split('/');
  const name = parts[parts.length - 1] ?? model;
  return name.length > 24 ? `${name.slice(0, 22)}…` : name;
}

function getTools(configs: Record<string, RuntimeAgentConfig>, deployment: AgentDeployment): number {
  const cfg = configs[deployment.name];
  return cfg?.tools?.length ?? 0;
}

function getChannelCount(deployment: AgentDeployment): number {
  return Object.keys(deployment.config?.channels ?? {}).length;
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

function statusDotColor(status: string): string {
  if (status === 'running') return 'bg-green';
  if (status === 'error' || status === 'stopped') return 'bg-red';
  return 'bg-yellow'; // provisioning / starting
}

function Agents(): JSX.Element {
  const { deployments, loading, loadDeployments, stop, remove } = useDeploymentsStore();
  const configs = useAgentConfigsStore((s) => s.configs);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    name: string;
    workspace?: string;
  } | null>(null);
  const [deleteWorkspace, setDeleteWorkspace] = useState(false);

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  const filtered = deployments.filter((d) => d.name.toLowerCase().includes(search.toLowerCase()));

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
        {loading && deployments.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex gap-1.5 items-center text-muted text-sm">
              <span className="animate-bounce [animation-delay:0ms]">•</span>
              <span className="animate-bounce [animation-delay:150ms]">•</span>
              <span className="animate-bounce [animation-delay:300ms]">•</span>
            </div>
          </div>
        ) : deployments.length === 0 ? (
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
                <span className="w-24 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                  CHANNELS
                </span>
                <span className="w-28 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-muted">
                  LAST ACTIVE
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
                filtered.map((deployment) => (
                  <AgentRow
                    key={deployment.id}
                    deployment={deployment}
                    onNavigate={() =>
                      navigate({ to: '/agents/$id', params: { id: deployment.id } })
                    }
                    onStop={() => stop(deployment.id)}
                    onRemove={() => {
                      setDeleteWorkspace(false);
                      setRemoveTarget({
                        id: deployment.id,
                        name: deployment.name,
                        workspace: deployment.workspace,
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
              This will remove the deployment. The agent process will be stopped.
            </p>

            {removeTarget.workspace && (
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={deleteWorkspace}
                  onChange={(e) => setDeleteWorkspace(e.target.checked)}
                  className="accent-accent"
                />
                <span>
                  Also delete workspace at{' '}
                  <span className="font-[family-name:var(--font-mono)] text-xs">
                    {removeTarget.workspace}
                  </span>
                </span>
              </label>
            )}

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
                  await remove(id, deleteWorkspace);
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
  deployment: AgentDeployment;
  onNavigate(): void;
  onStop(): void;
  onRemove(): void;
}

function AgentRow({ deployment, onNavigate, onStop, onRemove }: AgentRowProps): JSX.Element {
  const configs = useAgentConfigsStore((s) => s.configs);
  const toolCount = getTools(configs, deployment);
  const channelCount = getChannelCount(deployment);
  const model = getModel(configs, deployment);

  return (
    <button
      type="button"
      className="w-full border-b border-border flex items-center px-5 py-3.5 hover:bg-card-hover cursor-pointer transition-colors group last:border-b-0 text-left"
      onClick={onNavigate}
    >
      {/* Status */}
      <div className="w-16 flex items-center">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotColor(deployment.status)}`}
        />
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0 text-left">
        <span className="font-[family-name:var(--font-display)] font-semibold text-sm text-foreground">
          {deployment.name}
        </span>
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

      {/* Channels */}
      <div className="w-24">
        <span className="bg-accent-tint text-accent text-xs px-2 py-0.5 rounded font-semibold">
          {channelCount}
        </span>
      </div>

      {/* Last Active */}
      <div className="w-28">
        <span className="text-xs text-muted">{relativeTime(deployment.createdAt)}</span>
      </div>

      {/* Actions — visible on row hover */}
      <div
        className="w-16 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        {deployment.status === 'running' && (
          <button
            type="button"
            onClick={onStop}
            title="Stop"
            className="p-1.5 text-muted transition-colors hover:bg-surface hover:text-foreground rounded"
          >
            <Square size={13} />
          </button>
        )}
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
