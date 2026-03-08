import type { MessagingApp, RoutingCondition, RoutingRule } from '@dash/mc';
import { Link, createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';
import { useMessagingAppsStore } from '../../stores/messaging-apps';

function MessagingAppDetail(): JSX.Element {
  const { id } = Route.useParams();
  const { apps, loadApps, updateApp, error } = useMessagingAppsStore();
  const { deployments, loading: deploymentsLoading, loadDeployments } = useDeploymentsStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'routing'>('overview');
  const [globalDenyInput, setGlobalDenyInput] = useState('');
  const [showAddRule, setShowAddRule] = useState(false);

  useEffect(() => {
    loadApps();
    loadDeployments();
  }, [loadApps, loadDeployments]);

  const app = apps.find((a) => a.id === id);

  if (!app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-muted">Messaging app not found.</p>
        <Link to="/messaging-apps" className="text-sm text-primary hover:text-primary-hover">
          ← Back to Messaging Apps
        </Link>
      </div>
    );
  }

  const availableAgents = deployments
    .filter((d) => d.status === 'running')
    .flatMap((d) =>
      Object.keys(d.config.agents ?? {}).map((agentName) => ({
        label: `${agentName} (${d.name})`,
        agentName,
      })),
    );

  // All agent names across all deployments (running or stopped).
  // Used to detect routing rules that reference non-existent agents.
  // null while deployments are loading to avoid false positives on first render.
  const knownAgentNames: Set<string> | null = deploymentsLoading
    ? null
    : new Set(deployments.flatMap((d) => Object.keys(d.config.agents ?? {})));

  async function addGlobalDeny() {
    const val = globalDenyInput.trim();
    if (!val) return;
    await updateApp(id, { globalDenyList: [...app.globalDenyList, val] });
    setGlobalDenyInput('');
  }

  async function removeGlobalDeny(entry: string) {
    await updateApp(id, { globalDenyList: app.globalDenyList.filter((e) => e !== entry) });
  }

  async function removeRule(ruleId: string) {
    await updateApp(id, { routing: app.routing.filter((r) => r.id !== ruleId) });
  }

  async function moveRule(ruleId: string, direction: 'up' | 'down') {
    const idx = app.routing.findIndex((r) => r.id === ruleId);
    if (idx < 0) return;
    const newRouting = [...app.routing];
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= newRouting.length) return;
    [newRouting[idx], newRouting[swapIdx]] = [newRouting[swapIdx], newRouting[idx]];
    await updateApp(id, { routing: newRouting });
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <Link
          to="/messaging-apps"
          className="rounded p-1.5 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{app.name}</h1>
          <p className="text-sm text-muted capitalize">{app.type} bot</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex border-b border-border">
        {(['overview', 'routing'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 pb-3 text-sm capitalize transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted hover:text-foreground'
            }`}
          >
            {tab === 'overview' ? 'Overview' : 'Routing Rules'}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-600/40 bg-red-900/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <InfoCard label="Type" value={app.type} />
            <InfoCard label="Status" value={app.enabled ? 'Enabled' : 'Disabled'} />
            <InfoCard label="Created" value={new Date(app.createdAt).toLocaleDateString()} />
            <InfoCard label="Routing Rules" value={String(app.routing.length)} />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted">Enable / Disable</h2>
            <button
              type="button"
              onClick={() => updateApp(id, { enabled: !app.enabled })}
              className={`rounded-lg px-4 py-2 text-sm transition-colors ${
                app.enabled
                  ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50'
                  : 'bg-green-900/30 text-green-400 hover:bg-green-900/50'
              }`}
            >
              {app.enabled ? 'Disable this bot' : 'Enable this bot'}
            </button>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted">Global Block List</h2>
            <p className="mb-3 text-xs text-muted">
              These senders are always blocked, regardless of routing rules. Add their Telegram user
              ID (a number like <code>123456789</code>).
            </p>
            {app.globalDenyList.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {app.globalDenyList.map((entry) => (
                  <span
                    key={entry}
                    className="flex items-center gap-1 rounded bg-sidebar-hover px-2 py-1 font-mono text-xs"
                  >
                    {entry}
                    <button
                      type="button"
                      onClick={() => removeGlobalDeny(entry)}
                      className="text-muted hover:text-red-400"
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
                placeholder="Enter Telegram user ID"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={addGlobalDeny}
                className="rounded-lg bg-primary px-3 py-2 text-sm text-white hover:bg-primary-hover"
              >
                Block
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'routing' && (
        <div>
          {app.routing.length === 0 ? (
            <div className="rounded-lg border border-border bg-sidebar-bg p-6 text-center text-sm text-muted">
              No routing rules yet. Add one below.
            </div>
          ) : (
            <div className="space-y-2">
              {app.routing.map((rule, i) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  index={i}
                  total={app.routing.length}
                  knownAgentNames={knownAgentNames}
                  onMoveUp={() => moveRule(rule.id, 'up')}
                  onMoveDown={() => moveRule(rule.id, 'down')}
                  onDelete={() => removeRule(rule.id)}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowAddRule(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted hover:bg-sidebar-hover hover:text-foreground"
          >
            <Plus size={14} />
            Add routing rule
          </button>

          {showAddRule && (
            <AddRulePanel
              availableAgents={availableAgents}
              onAdd={async (rule) => {
                await updateApp(id, { routing: [...app.routing, rule] });
                setShowAddRule(false);
              }}
              onCancel={() => setShowAddRule(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RuleCard({
  rule,
  index,
  total,
  knownAgentNames,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  rule: RoutingRule;
  index: number;
  total: number;
  knownAgentNames: Set<string> | null;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}): JSX.Element {
  const agentMissing = knownAgentNames !== null && !knownAgentNames.has(rule.targetAgentName);
  const conditionLabel =
    rule.condition.type === 'default'
      ? 'Everyone (default)'
      : rule.condition.type === 'sender'
        ? `Specific senders: ${rule.condition.ids.join(', ')}`
        : `Groups: ${rule.condition.ids.join(', ')}`;

  return (
    <div className="rounded-lg border border-border bg-sidebar-bg p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted">Rule {index + 1}</p>
          <p className="mt-0.5 text-sm">{conditionLabel}</p>
          <p className="mt-1 text-xs text-muted">
            →{' '}
            <strong className={agentMissing ? 'text-amber-400' : undefined}>
              {rule.targetAgentName}
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
          {rule.label && <p className="mt-1 text-xs text-muted italic">"{rule.label}"</p>}
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
            className="rounded p-1 text-muted hover:text-red-400"
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
  availableAgents: Array<{ agentName: string; label: string }>;
  onAdd: (rule: RoutingRule) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [conditionType, setConditionType] = useState<'default' | 'sender' | 'group'>('default');
  const [conditionIds, setConditionIds] = useState('');
  const [agentName, setAgentName] = useState(availableAgents[0]?.agentName ?? '');
  const [allowList, setAllowList] = useState('');
  const [denyList, setDenyList] = useState('');
  const [label, setLabel] = useState('');

  function buildCondition(): RoutingCondition {
    const ids = conditionIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (conditionType === 'sender') return { type: 'sender', ids };
    if (conditionType === 'group') return { type: 'group', ids };
    return { type: 'default' };
  }

  async function handleAdd() {
    const rule: RoutingRule = {
      id: `rule-${Date.now()}`,
      label: label.trim() || undefined,
      condition: buildCondition(),
      targetAgentName: agentName,
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
    <div className="mt-4 rounded-lg border border-primary/30 bg-sidebar-bg p-4">
      <h3 className="mb-4 text-sm font-medium">Add routing rule</h3>
      <div className="space-y-3">
        <div>
          <label htmlFor="rule-condition-type" className="block text-xs text-muted">
            Who triggers this rule?
          </label>
          <select
            id="rule-condition-type"
            value={conditionType}
            onChange={(e) => setConditionType(e.target.value as typeof conditionType)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="default">Everyone (default / catch-all)</option>
            <option value="sender">Specific people (by Telegram user ID)</option>
            <option value="group">Specific groups (by group chat ID)</option>
          </select>
        </div>

        {conditionType !== 'default' && (
          <div>
            <label htmlFor="rule-condition-ids" className="block text-xs text-muted">
              {conditionType === 'sender' ? 'Telegram user IDs' : 'Group chat IDs'}{' '}
              (comma-separated)
            </label>
            <input
              id="rule-condition-ids"
              type="text"
              value={conditionIds}
              onChange={(e) => setConditionIds(e.target.value)}
              placeholder="123456789, 987654321"
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-sm"
            />
          </div>
        )}

        <div>
          <label htmlFor="rule-agent-name" className="block text-xs text-muted">
            Route to agent
          </label>
          <select
            id="rule-agent-name"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            {availableAgents.map((a) => (
              <option key={a.agentName} value={a.agentName}>
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
              <label htmlFor="rule-allow-list" className="block text-xs text-muted">
                Only allow these senders (IDs, comma-separated — leave empty to allow all)
              </label>
              <input
                id="rule-allow-list"
                type="text"
                value={allowList}
                onChange={(e) => setAllowList(e.target.value)}
                placeholder="Leave empty to allow all"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              />
            </div>
            <div>
              <label htmlFor="rule-deny-list" className="block text-xs text-muted">
                Always block these senders from this agent (IDs, comma-separated)
              </label>
              <input
                id="rule-deny-list"
                type="text"
                value={denyList}
                onChange={(e) => setDenyList(e.target.value)}
                placeholder="Leave empty to block nobody"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              />
            </div>
          </div>
        </details>

        <div>
          <label htmlFor="rule-label" className="block text-xs text-muted">
            Rule label (optional)
          </label>
          <input
            id="rule-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='e.g. "VIP Clients" or "Support Group"'
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!agentName}
          className="rounded-lg bg-primary px-4 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          Add rule
        </button>
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-sidebar-bg p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-sm font-medium">{value}</p>
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/$id')({
  component: MessagingAppDetail,
});
