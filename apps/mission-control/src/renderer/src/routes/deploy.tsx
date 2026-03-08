import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, Loader, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RendererDeploymentError } from '../../../shared/ipc';
import { ModelChainEditor } from '../components/ModelChainEditor.js';
import { AVAILABLE_MODELS, AVAILABLE_TOOLS } from '../components/deploy-options.js';
import { useAvailableModels } from '../hooks/useAvailableModels.js';
import { useDeploymentsStore } from '../stores/deployments';

type Step = 'agent' | 'channels' | 'review';

interface AgentConfig {
  name: string;
  model: string;
  fallbackModels: string[];
  systemPrompt: string;
  tools: string[];
  workspace: string; // '' means auto-generate
}

interface ChannelConfig {
  enableTelegram: boolean;
}

export function DeployWizard(): JSX.Element {
  const navigate = useNavigate();
  const { deployWithConfig } = useDeploymentsStore();
  const availableModels = useAvailableModels();
  const [step, setStep] = useState<Step>('agent');
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployStartupLogs, setDeployStartupLogs] = useState<string[]>([]);

  const [agent, setAgent] = useState<AgentConfig>({
    name: '',
    model: AVAILABLE_MODELS[0].value, // use static list for initial value
    fallbackModels: [],
    systemPrompt: '',
    tools: [],
    workspace: '',
  });

  useEffect(() => {
    window.api
      .settingsGet()
      .then((settings) => {
        if (settings.defaultModel) {
          setAgent((prev) => ({
            ...prev,
            model: settings.defaultModel!,
            fallbackModels: settings.defaultFallbackModels ?? [],
          }));
        }
      })
      .catch(() => {});
  }, []);

  const [channels, setChannels] = useState<ChannelConfig>({
    enableTelegram: false,
  });
  const [telegramTokenMissing, setTelegramTokenMissing] = useState(false);

  const canAdvanceAgent = agent.name.trim().length > 0;

  const handleDeploy = async (): Promise<void> => {
    setDeploying(true);
    setDeployError(null);
    setDeployStartupLogs([]);
    try {
      const id = await deployWithConfig({
        name: agent.name.trim(),
        model: agent.model,
        fallbackModels: agent.fallbackModels.length > 0 ? agent.fallbackModels : undefined,
        systemPrompt: agent.systemPrompt,
        tools: agent.tools,
        enableTelegram: channels.enableTelegram,
        workspace: agent.workspace || undefined,
      });
      navigate({ to: '/agents/$id', params: { id } });
    } catch (err: unknown) {
      setDeployError((err as Error).message);
      setDeployStartupLogs(err instanceof RendererDeploymentError ? err.startupLogs : []);
      setDeploying(false);
    }
  };

  const handleBrowseWorkspace = async (): Promise<void> => {
    const selected = await window.api.dialogOpenDirectory();
    if (selected) {
      setAgent((prev) => ({ ...prev, workspace: selected }));
    }
  };

  const toggleTool = (tool: string): void => {
    setAgent((prev) => ({
      ...prev,
      tools: prev.tools.includes(tool)
        ? prev.tools.filter((t) => t !== tool)
        : [...prev.tools, tool],
    }));
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Deploy Agent</h1>
        <p className="mt-1 text-sm text-muted">Configure and launch a new Dash agent.</p>
      </div>

      <StepIndicator current={step} />

      {step === 'agent' && (
        <div className="space-y-6">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Agent Name</span>
            <input
              type="text"
              value={agent.name}
              onChange={(e) => setAgent((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="my-agent"
              className="w-full rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </label>

          <div>
            <span className="mb-1 block text-sm font-medium">Model</span>
            <ModelChainEditor
              model={agent.model}
              fallbackModels={agent.fallbackModels}
              availableModels={availableModels}
              onChange={(model, fallbackModels) =>
                setAgent((prev) => ({ ...prev, model, fallbackModels }))
              }
            />
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">System Prompt</span>
            <textarea
              value={agent.systemPrompt}
              onChange={(e) => setAgent((prev) => ({ ...prev, systemPrompt: e.target.value }))}
              placeholder="You are a helpful assistant..."
              rows={4}
              className="w-full rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </label>

          <div>
            <span className="mb-2 block text-sm font-medium">Tools</span>
            <div className="grid grid-cols-2 gap-2">
              {AVAILABLE_TOOLS.map((tool) => (
                <label
                  key={tool.value}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-sidebar-hover"
                >
                  <input
                    type="checkbox"
                    checked={agent.tools.includes(tool.value)}
                    onChange={() => toggleTool(tool.value)}
                    className="accent-primary"
                  />
                  {tool.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium">Workspace</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={agent.workspace}
                placeholder="Auto-generated"
                className="flex-1 rounded-lg border border-border bg-sidebar-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
              {agent.workspace && (
                <button
                  type="button"
                  onClick={() => setAgent((prev) => ({ ...prev, workspace: '' }))}
                  className="rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={handleBrowseWorkspace}
                className="rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
              >
                Browse…
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">
              The directory where this agent's file tools will be sandboxed.
            </p>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!canAdvanceAgent}
              onClick={() => setStep('channels')}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              Next
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {step === 'channels' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-sidebar-bg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Mission Control Chat</p>
                <p className="text-xs text-muted">
                  Chat with your agent from the Mission Control UI
                </p>
              </div>
              <span className="rounded bg-green-900/30 px-2 py-0.5 text-xs text-green-400">
                Always enabled
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-sidebar-bg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Telegram Bot</p>
                <p className="text-xs text-muted">
                  Connect your agent to Telegram (requires telegram-bot-token in Secrets)
                </p>
              </div>
              <button
                type="button"
                aria-label="Toggle Telegram"
                onClick={async () => {
                  if (!channels.enableTelegram) {
                    const token = await window.api.secretsGet('telegram-bot-token');
                    setTelegramTokenMissing(!token);
                  } else {
                    setTelegramTokenMissing(false);
                  }
                  setChannels((prev) => ({ ...prev, enableTelegram: !prev.enableTelegram }));
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${channels.enableTelegram ? 'bg-primary' : 'bg-border'}`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${channels.enableTelegram ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>
            {channels.enableTelegram && telegramTokenMissing && (
              <p className="mt-2 text-xs text-red-400">
                telegram-bot-token not found in Secrets. Add it on the Secrets page before
                deploying.
              </p>
            )}
          </div>

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep('agent')}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
            >
              <ArrowLeft size={16} />
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep('review')}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover"
            >
              Next
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-sidebar-bg p-4 space-y-3">
            <ReviewRow label="Name" value={agent.name} />
            <ReviewRow
              label="Model"
              value={[agent.model, ...agent.fallbackModels]
                .map((v) => AVAILABLE_MODELS.find((m) => m.value === v)?.label ?? v)
                .join(' → ')}
            />
            <ReviewRow label="System Prompt" value={agent.systemPrompt || '(default)'} multiline />
            <ReviewRow
              label="Tools"
              value={agent.tools.length > 0 ? agent.tools.join(', ') : '(none)'}
            />
            <ReviewRow label="Workspace" value={agent.workspace || 'Auto-generated'} />
            <ReviewRow
              label="Channels"
              value={channels.enableTelegram ? 'Mission Control, Telegram' : 'Mission Control'}
            />
          </div>

          {deployError && (
            <div className="space-y-2">
              <div className="rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-400">
                {deployError}
              </div>
              {deployStartupLogs.length > 0 && (
                <details className="rounded-lg border border-red-900/30">
                  <summary className="cursor-pointer px-4 py-2 text-xs text-red-400/70 hover:text-red-400">
                    Startup logs ({deployStartupLogs.length} lines)
                  </summary>
                  <div className="max-h-48 overflow-auto rounded-b-lg bg-[#0d0d0d] p-3 font-mono text-xs leading-5">
                    {deployStartupLogs.map((line, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: log lines are ordered by index
                      <div key={i} className="text-red-300/70">
                        {line}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep('channels')}
              disabled={deploying}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-50"
            >
              <ArrowLeft size={16} />
              Back
            </button>
            <button
              type="button"
              onClick={handleDeploy}
              disabled={deploying}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {deploying ? (
                <>
                  <Loader size={16} className="animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Rocket size={16} />
                  Deploy
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ current }: { current: Step }): JSX.Element {
  const steps: { key: Step; label: string }[] = [
    { key: 'agent', label: 'Agent' },
    { key: 'channels', label: 'Channels' },
    { key: 'review', label: 'Review' },
  ];

  const currentIndex = steps.findIndex((s) => s.key === current);

  return (
    <div className="mb-8 flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          {i > 0 && <div className="h-px w-8 bg-border" />}
          <div className="flex items-center gap-2">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                i < currentIndex
                  ? 'bg-primary text-white'
                  : i === currentIndex
                    ? 'bg-primary text-white'
                    : 'bg-border text-muted'
              }`}
            >
              {i < currentIndex ? <Check size={12} /> : i + 1}
            </div>
            <span className={`text-sm ${i <= currentIndex ? 'text-foreground' : 'text-muted'}`}>
              {s.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewRow({
  label,
  value,
  multiline,
}: { label: string; value: string; multiline?: boolean }): JSX.Element {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 text-sm ${multiline ? 'whitespace-pre-wrap' : ''}`}>{value}</p>
    </div>
  );
}

export const Route = createFileRoute('/deploy')({
  component: DeployWizard,
});
