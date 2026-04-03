import type { GatewayChannel } from '@dash/mc';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAgentsStore } from '../../stores/agents.js';
import { useChannelsStore } from '../../stores/messaging-apps.js';

function PlatformIcon({ type }: { type: string }): JSX.Element {
  if (type === 'whatsapp') {
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        className="text-[#25D366]"
        role="img"
        aria-label="WhatsApp"
      >
        <path
          d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.956 9.956 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"
          fill="currentColor"
          fillOpacity="0.2"
        />
        <path
          d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className="text-[#229ED9]"
      role="img"
      aria-label="Telegram"
    >
      <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.2" />
      <path d="M17.5 7L10 13.5 7 12l10.5-5zM10 13.5l.8 3.5 2-2.2-2.8-1.3z" fill="currentColor" />
    </svg>
  );
}

type ChannelRouteRule = GatewayChannel['routing'][number];

function MessagingAppDetail(): JSX.Element {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { channels, loadChannels, updateChannel, removeChannel, error } = useChannelsStore();
  const { agents, loading: agentsLoading, loadAgents } = useAgentsStore();
  const [globalDenyInput, setGlobalDenyInput] = useState('');
  const [showAddRule, setShowAddRule] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    loadChannels();
    loadAgents();
  }, [loadChannels, loadAgents]);

  const channel = channels.find((ch) => ch.name === id);

  if (!channel) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-muted">Messaging app not found.</p>
        <Link to="/messaging-apps" className="text-sm text-accent hover:underline">
          ← Back to Messaging Apps
        </Link>
      </div>
    );
  }

  const availableAgents = agents
    .filter((a) => a.status === 'active' || a.status === 'registered')
    .map((a) => ({
      label: a.name,
      agentId: a.id,
    }));

  const knownAgentIds: Set<string> | null = agentsLoading
    ? null
    : new Set(agents.map((a) => a.id));

  async function addGlobalDeny() {
    const val = globalDenyInput.trim();
    if (!val) return;
    await updateChannel(id, { globalDenyList: [...channel.globalDenyList, val] });
    setGlobalDenyInput('');
  }

  async function removeGlobalDeny(entry: string) {
    await updateChannel(id, { globalDenyList: channel.globalDenyList.filter((e) => e !== entry) });
  }

  async function removeRule(index: number) {
    await updateChannel(id, { routing: channel.routing.filter((_, i) => i !== index) });
  }

  async function moveRule(index: number, direction: 'up' | 'down') {
    const newRouting = [...channel.routing];
    const swapIdx = direction === 'up' ? index - 1 : index + 1;
    if (swapIdx < 0 || swapIdx >= newRouting.length) return;
    [newRouting[index], newRouting[swapIdx]] = [newRouting[swapIdx], newRouting[index]];
    await updateChannel(id, { routing: newRouting });
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center gap-4 shrink-0">
        <Link
          to="/messaging-apps"
          className="rounded p-1.5 text-muted transition-colors hover:bg-card-hover hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="flex items-center gap-3 flex-1">
          <PlatformIcon type={channel.adapter} />
          <div>
            <h1 className="text-2xl font-bold font-[family-name:var(--font-display)]">
              {channel.name}
            </h1>
            <p className="text-sm text-muted capitalize">{channel.adapter} bot</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="rounded p-1.5 text-muted transition-colors hover:bg-red-900/20 hover:text-red"
          title="Delete channel"
        >
          <Trash2 size={16} />
        </button>
        <span className="bg-green-tint text-green rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
          Connected
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-8">
      {error && (
        <div className="mb-4 rounded-lg border border-red-600/40 bg-red-tint px-4 py-3 text-sm text-red">
          {error}
        </div>
      )}

      {/* Two-column body */}
      <div className="flex gap-6">
        {/* Left column: Connection Details */}
        <div className="flex-1">
          <div className="bg-card-bg border border-border rounded-lg p-5">
            <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent mb-4">
              Connection Details
            </p>

            <div className="space-y-3">
              <DetailRow label="Type" value={<span className="capitalize">{channel.adapter}</span>} />
              <DetailRow label="Registered" value={new Date(channel.registeredAt).toLocaleDateString()} />
              <DetailRow label="Routing Rules" value={String(channel.routing.length)} />
            </div>
          </div>

          {/* Global Block List */}
          <div className="bg-card-bg border border-border rounded-lg p-5 mt-4">
            <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent mb-4">
              Global Block List
            </p>
            <p className="mb-3 text-xs text-muted">
              These senders are always blocked, regardless of routing rules.
            </p>
            {channel.globalDenyList.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {channel.globalDenyList.map((entry) => (
                  <span
                    key={entry}
                    className="flex items-center gap-1 rounded bg-surface px-2 py-1 font-[family-name:var(--font-mono)] text-xs"
                  >
                    {entry}
                    <button
                      type="button"
                      onClick={() => removeGlobalDeny(entry)}
                      className="text-muted hover:text-red"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={globalDenyInput}
                onChange={(e) => setGlobalDenyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addGlobalDeny()}
                placeholder="Enter sender ID"
                className="flex-1 rounded-lg border border-border bg-card-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={addGlobalDeny}
                className="rounded-lg bg-accent px-3 py-2 text-sm text-white hover:opacity-90"
              >
                Block
              </button>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="w-[360px] flex flex-col gap-4">
          {/* Connected Agents */}
          <div className="bg-card-bg border border-border rounded-lg p-5">
            <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent mb-4">
              Connected Agents
            </p>
            {channel.routing.length === 0 ? (
              <p className="text-xs text-muted">No routing rules configured yet.</p>
            ) : (
              <div className="space-y-2">
                {channel.routing.map((rule, i) => (
                  <RuleCard
                    key={`rule-${i}`}
                    rule={rule}
                    index={i}
                    total={channel.routing.length}
                    agents={agents}
                    knownAgentIds={knownAgentIds}
                    onMoveUp={() => moveRule(i, 'up')}
                    onMoveDown={() => moveRule(i, 'down')}
                    onDelete={() => removeRule(i)}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowAddRule(true)}
              className="mt-4 inline-flex items-center gap-2 text-accent text-xs hover:underline"
            >
              <Plus size={12} />
              Add routing rule
            </button>

            {showAddRule && (
              <AddRulePanel
                availableAgents={availableAgents}
                onAdd={async (rule) => {
                  await updateChannel(id, { routing: [...channel.routing, rule] });
                  setShowAddRule(false);
                }}
                onCancel={() => setShowAddRule(false)}
              />
            )}
          </div>
        </div>
      </div>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <DeleteConfirmDialog
          channel={channel}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={async () => {
            setShowDeleteConfirm(false);
            await removeChannel(id);
            navigate({ to: '/messaging-apps' });
          }}
        />
      )}
    </div>
  );
}

function DeleteConfirmDialog({
  channel,
  onCancel,
  onConfirm,
}: {
  channel: GatewayChannel;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm border border-border bg-card-bg p-6 shadow-lg">
        <h2 className="text-base font-semibold font-[family-name:var(--font-display)]">
          Delete {channel.name}?
        </h2>
        <p className="mt-1 text-sm text-muted">
          This will permanently delete this {channel.adapter} connection.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}

function RuleCard({
  rule,
  index,
  total,
  agents,
  knownAgentIds,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  rule: ChannelRouteRule;
  index: number;
  total: number;
  agents: Array<{ id: string; name: string }>;
  knownAgentIds: Set<string> | null;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}): JSX.Element {
  const agentMissing = knownAgentIds !== null && !knownAgentIds.has(rule.agentId);
  const agentName = agents.find((a) => a.id === rule.agentId)?.name ?? rule.agentId;
  const conditionLabel =
    rule.condition.type === 'default'
      ? 'Everyone (default)'
      : rule.condition.type === 'sender'
        ? `Specific senders: ${rule.condition.ids.join(', ')}`
        : `Groups: ${rule.condition.ids.join(', ')}`;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted">Rule {index + 1}</p>
          <p className="mt-0.5 text-sm">{conditionLabel}</p>
          <p className="mt-1 text-xs text-muted">
            →{' '}
            <strong className={agentMissing ? 'text-amber-400' : undefined}>
              {agentName}
            </strong>
            {agentMissing && (
              <span
                className="ml-1.5 inline-flex items-center gap-1 text-amber-400"
                title="Agent not found — messages matching this rule will be dropped"
              >
                <AlertTriangle size={11} />
                Agent not found
              </span>
            )}
            {rule.allowList.length > 0 && ` · Allow: ${rule.allowList.join(', ')}`}
            {rule.denyList.length > 0 && ` · Block: ${rule.denyList.join(', ')}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            className="rounded p-1 text-muted hover:text-foreground disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1}
            className="rounded p-1 text-muted hover:text-foreground disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1 text-muted hover:text-red"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function AddRulePanel({
  availableAgents,
  onAdd,
  onCancel,
}: {
  availableAgents: Array<{ agentId: string; label: string }>;
  onAdd: (rule: ChannelRouteRule) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [conditionType, setConditionType] = useState<'default' | 'sender' | 'group'>('sender');
  const [conditionIds, setConditionIds] = useState('');
  const [agentId, setAgentId] = useState(availableAgents[0]?.agentId ?? '');
  const [allowList, setAllowList] = useState('');
  const [denyList, setDenyList] = useState('');
  const [showEveryoneWarning, setShowEveryoneWarning] = useState(false);
  const [everyoneConfirmed, setEveryoneConfirmed] = useState(false);

  function buildCondition(): ChannelRouteRule['condition'] {
    const ids = conditionIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (conditionType === 'sender') return { type: 'sender', ids };
    if (conditionType === 'group') return { type: 'group', ids };
    return { type: 'default' };
  }

  async function handleAdd() {
    const rule: ChannelRouteRule = {
      condition: buildCondition(),
      agentId,
      allowList: allowList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      denyList: denyList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    await onAdd(rule);
  }

  return (
    <div className="mt-4 rounded-lg border border-accent/30 bg-surface p-4">
      <h3 className="mb-4 font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted">
        Add routing rule
      </h3>
      <div className="space-y-3">
        <div>
          <label
            htmlFor="rule-condition-type"
            className="block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted mb-1"
          >
            Who triggers this rule?
          </label>
          <select
            id="rule-condition-type"
            value={conditionType}
            onChange={(e) => {
              const val = e.target.value as typeof conditionType;
              if (val === 'default') {
                setShowEveryoneWarning(true);
                setEveryoneConfirmed(false);
              } else {
                setShowEveryoneWarning(false);
                setEveryoneConfirmed(false);
              }
              setConditionType(val);
            }}
            className="w-full border border-border bg-card-bg px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          >
            <option value="sender">Specific people</option>
            <option value="group">Specific groups</option>
            <option value="default">Everyone</option>
          </select>

          {showEveryoneWarning && !everyoneConfirmed && (
            <div className="mt-2 border-2 border-red/40 bg-red-tint p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-red shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium text-red">
                    This will allow anyone to message this agent.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setConditionType('sender');
                        setShowEveryoneWarning(false);
                      }}
                      className="border border-border px-2 py-1 text-[10px] text-muted hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEveryoneConfirmed(true);
                        setShowEveryoneWarning(false);
                      }}
                      className="bg-red/80 px-2 py-1 text-[10px] text-white hover:bg-red transition-colors"
                    >
                      I understand, allow everyone
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {conditionType !== 'default' && (
          <div>
            <label
              htmlFor="rule-condition-ids"
              className="block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted mb-1"
            >
              {conditionType === 'sender' ? 'Sender IDs' : 'Group IDs'} (comma-separated)
            </label>
            <input
              id="rule-condition-ids"
              type="text"
              value={conditionIds}
              onChange={(e) => setConditionIds(e.target.value)}
              placeholder="123456789, 987654321"
              className="w-full border border-border bg-card-bg px-2 py-1.5 font-[family-name:var(--font-mono)] text-sm focus:border-accent focus:outline-none"
            />
          </div>
        )}

        <div>
          <label
            htmlFor="rule-agent-id"
            className="block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted mb-1"
          >
            Route to agent
          </label>
          <select
            id="rule-agent-id"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded border border-border bg-card-bg px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          >
            {availableAgents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            Advanced: allow/deny lists (optional)
          </summary>
          <div className="mt-2 space-y-2">
            <div>
              <label
                htmlFor="rule-allow-list"
                className="block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted mb-1"
              >
                Only allow these senders (IDs, comma-separated)
              </label>
              <input
                id="rule-allow-list"
                type="text"
                value={allowList}
                onChange={(e) => setAllowList(e.target.value)}
                placeholder="Leave empty to allow all"
                className="w-full rounded border border-border bg-card-bg px-2 py-1 font-[family-name:var(--font-mono)] text-xs focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="rule-deny-list"
                className="block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted mb-1"
              >
                Always block these senders (IDs, comma-separated)
              </label>
              <input
                id="rule-deny-list"
                type="text"
                value={denyList}
                onChange={(e) => setDenyList(e.target.value)}
                placeholder="Leave empty to block nobody"
                className="w-full rounded border border-border bg-card-bg px-2 py-1 font-[family-name:var(--font-mono)] text-xs focus:border-accent focus:outline-none"
              />
            </div>
          </div>
        </details>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm border border-border text-muted rounded-lg hover:bg-card-hover hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!agentId || (conditionType === 'default' && !everyoneConfirmed)}
          className="bg-accent px-4 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
        >
          Add rule
        </button>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/$id')({
  component: MessagingAppDetail,
});
