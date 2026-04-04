import type { GatewayAgent, GatewayChannel } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  Check,
  Loader,
  MessageSquare,
  Pencil,
  Play,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentsStore } from '../../stores/agents.js';
import { useChannelsStore } from '../../stores/messaging-apps.js';
import { AgentConfigTab } from './-components/AgentConfigTab.js';

type TabId = 'overview' | 'configuration' | 'channels';

export function AgentDetail(): JSX.Element {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { agents, loadAgents, disableAgent, enableAgent, removeAgent, updateAgent } =
    useAgentsStore();
  const { channels, loadChannels } = useChannelsStore();
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const agent = agents.find((a) => a.id === id);

  useEffect(() => {
    loadAgents().then(() => setLoading(false));
  }, [loadAgents]);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  const handleDisable = useCallback(async () => {
    await disableAgent(id);
  }, [id, disableAgent]);

  const handleEnable = useCallback(async () => {
    await enableAgent(id);
  }, [id, enableAgent]);

  const handleRemove = useCallback(async () => {
    await removeAgent(id);
    navigate({ to: '/agents' });
  }, [id, removeAgent, navigate]);

  const handleStartRename = useCallback(() => {
    setNewName(agent?.name ?? '');
    setEditingName(true);
  }, [agent?.name]);

  const handleCancelRename = useCallback(() => {
    setEditingName(false);
    setNewName('');
  }, []);

  const handleSaveRename = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === agent?.name) {
      setEditingName(false);
      return;
    }
    try {
      await updateAgent(id, { name: trimmed });
      setEditingName(false);
    } catch (err) {
      console.error('Failed to rename agent:', err);
    }
  }, [id, newName, agent?.name, updateAgent]);

  const handleUpdateConfig = useCallback(
    async (agentId: string, patch: Record<string, unknown>) => {
      await updateAgent(agentId, patch);
    },
    [updateAgent],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-muted">Agent not found.</p>
        <Link
          to="/agents"
          className="inline-flex items-center gap-2 text-sm text-accent hover:text-primary-hover"
        >
          <ArrowLeft size={14} />
          Back to Agents
        </Link>
      </div>
    );
  }

  const isActive = agent.status === 'active' || agent.status === 'registered';
  const isDisabled = agent.status === 'disabled';

  // Connected channels: channels whose routing targets this agent
  const connectedChannels = channels.filter((ch) =>
    ch.routing.some((rule) => rule.agentId === agent.id),
  );

  const TABS: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'configuration', label: 'Configuration' },
    { id: 'channels', label: 'Channels' },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center gap-4 shrink-0">
        <ArrowLeft
          size={20}
          className="text-muted cursor-pointer hover:text-foreground shrink-0"
          onClick={() => navigate({ to: '/agents' })}
        />
        {editingName ? (
          <div className="flex items-center gap-2">
            <input
              ref={nameInputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveRename();
                if (e.key === 'Escape') handleCancelRename();
              }}
              className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground bg-transparent border-b-2 border-accent outline-none px-1"
            />
            <button
              type="button"
              onClick={handleSaveRename}
              className="p-1 text-green hover:text-green/80 transition-colors"
              title="Save"
            >
              <Check size={18} />
            </button>
            <button
              type="button"
              onClick={handleCancelRename}
              className="p-1 text-muted hover:text-foreground transition-colors"
              title="Cancel"
            >
              <X size={18} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleStartRename}
            className="group flex items-center gap-2 font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground hover:text-accent transition-colors"
            title="Click to rename"
          >
            {agent.name}
            <Pencil
              size={14}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted"
            />
          </button>
        )}
        <StatusBadge status={agent.status} />
        <div className="ml-auto flex items-center gap-2">
          {isActive && (
            <button
              type="button"
              onClick={() => navigate({ to: '/chat', search: { agentId: id } })}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
            >
              <MessageSquare size={14} />
              Chat
            </button>
          )}
          {isDisabled && (
            <button
              type="button"
              onClick={handleEnable}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
            >
              <Play size={14} />
              Enable
            </button>
          )}
          {isActive && (
            <button
              type="button"
              onClick={handleDisable}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
            >
              <Square size={14} />
              Disable
            </button>
          )}
          {isDisabled && (
            <button
              type="button"
              onClick={handleRemove}
              className="inline-flex items-center gap-2 rounded-lg border border-red-900/50 px-3 py-2 text-sm text-red transition-colors hover:bg-red-900/30"
            >
              <Trash2 size={14} />
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-surface px-8 border-b border-border flex shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={
              activeTab === tab.id
                ? 'text-foreground font-semibold border-b-2 border-accent px-5 py-3.5 text-[13px] cursor-pointer'
                : 'text-muted font-medium px-5 py-3.5 text-[13px] cursor-pointer hover:text-foreground transition-colors'
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 p-8 overflow-y-auto">
        {activeTab === 'overview' && (
          <OverviewTab agent={agent} connectedChannels={connectedChannels} />
        )}
        {activeTab === 'configuration' && (
          <AgentConfigTab
            agentId={id}
            agentConfig={agent.config}
            workspace={agent.config.workspace}
            updateConfig={handleUpdateConfig}
          />
        )}
        {activeTab === 'channels' && <ChannelsTab connectedChannels={connectedChannels} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  agent,
  connectedChannels,
}: {
  agent: GatewayAgent;
  connectedChannels: GatewayChannel[];
}): JSX.Element {
  return (
    <div className="flex gap-6">
      {/* Left column */}
      <div className="w-[360px] flex flex-col gap-5 shrink-0">
        {/* Agent Info card */}
        <div className="bg-card-bg border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Agent Info
            </span>
          </div>
          <div className="p-5 flex flex-col gap-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted">Model</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {agent.config.model}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Registered</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {new Date(agent.registeredAt).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Status</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {agent.status}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">Tools</span>
              <span className="text-foreground font-[family-name:var(--font-mono)] text-xs">
                {agent.config.tools?.length ?? 0}
              </span>
            </div>
          </div>
        </div>

        {/* Connected Channels card */}
        <div className="bg-card-bg border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Connected Channels
            </span>
          </div>
          <div className="p-5 flex flex-col gap-3">
            {connectedChannels.length === 0 ? (
              <p className="text-sm text-muted">No channels connected</p>
            ) : (
              connectedChannels.map((ch) => (
                <div key={ch.name} className="flex justify-between text-sm">
                  <span className="text-foreground">{ch.name}</span>
                  <span className="text-foreground font-[family-name:var(--font-mono)] text-xs capitalize">
                    {ch.adapter}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Right column */}
      <div className="flex-1">
        <div className="bg-card-bg border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
              Recent Activity
            </span>
          </div>
          <div className="flex flex-col gap-0">
            <div className="px-5 py-3 text-sm text-muted">No activity recorded.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels tab
// ---------------------------------------------------------------------------

function ChannelsTab({ connectedChannels }: { connectedChannels: GatewayChannel[] }): JSX.Element {
  if (connectedChannels.length === 0) {
    return (
      <div className="py-12 flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted">No channels connected.</p>
        <p className="text-xs text-muted">
          Connect messaging apps from the{' '}
          <Link to="/messaging-apps" className="text-accent hover:text-primary-hover underline">
            Messaging Apps
          </Link>{' '}
          page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {connectedChannels.map((ch) => (
        <div
          key={ch.name}
          className="bg-card-bg border border-border p-5 flex items-center justify-between"
        >
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">{ch.name}</span>
            <span className="font-[family-name:var(--font-mono)] text-xs text-muted capitalize">
              {ch.adapter}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/messaging-apps"
              className="text-xs border border-border text-muted hover:text-foreground px-3 py-1.5 rounded transition-colors"
            >
              Edit
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: GatewayAgent['status'] }): JSX.Element {
  if (status === 'active' || status === 'registered') {
    return (
      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-green-tint text-green">
        <span className="w-1.5 h-1.5 rounded-full bg-green shrink-0" />
        active
      </span>
    );
  }
  if (status === 'disabled') {
    return (
      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-red-tint text-red">
        <span className="w-1.5 h-1.5 rounded-full bg-red shrink-0" />
        disabled
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold bg-sidebar-hover text-muted">
      {status}
    </span>
  );
}

export const Route = createFileRoute('/agents/$id')({
  component: AgentDetail,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
});
