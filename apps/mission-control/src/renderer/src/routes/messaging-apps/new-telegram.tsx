import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, CheckCircle, ExternalLink, Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';
import { useMessagingAppsStore } from '../../stores/messaging-apps';

type PathId = 'new' | 'know' | 'token';

type StepId =
  | 'choose-path'
  | 'what-is-telegram'
  | 'what-is-bot'
  | 'open-botfather'
  | 'create-bot'
  | 'copy-token'
  | 'paste-token'
  | 'name-connection'
  | 'choose-assistant'
  | 'done';

const PATH_STEPS: Record<PathId, StepId[]> = {
  new: [
    'what-is-telegram',
    'what-is-bot',
    'open-botfather',
    'create-bot',
    'copy-token',
    'paste-token',
    'name-connection',
    'choose-assistant',
    'done',
  ],
  know: [
    'open-botfather',
    'create-bot',
    'copy-token',
    'paste-token',
    'name-connection',
    'choose-assistant',
    'done',
  ],
  token: ['paste-token', 'name-connection', 'choose-assistant', 'done'],
};

function NewTelegramWizard(): JSX.Element {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const [path, setPath] = useState<PathId | null>(null);

  // Token verification state
  const [token, setToken] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [botInfo, setBotInfo] = useState<{ username: string; firstName: string } | null>(null);

  // Connection name
  const [connectionName, setConnectionName] = useState('');

  // Agent selection
  const { deployments, loadDeployments } = useDeploymentsStore();
  const [selectedAgent, setSelectedAgent] = useState<{
    deploymentId: string;
    agentName: string;
  } | null>(null);

  const { createApp } = useMessagingAppsStore();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  const steps = path ? PATH_STEPS[path] : [];
  const stepId: StepId = path ? steps[stepIndex] : 'choose-path';

  const goNext = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const goPrev = () => {
    if (stepIndex === 0) {
      setPath(null);
      setStepIndex(0);
    } else {
      setStepIndex((i) => i - 1);
    }
  };
  function choosePath(chosen: PathId) {
    setPath(chosen);
    setStepIndex(0);
  }

  // Build flat list of all agents across all running deployments
  const availableAgents = deployments
    .filter((d) => d.status === 'running')
    .map((d) => ({
      label: d.name,
      deploymentId: d.id,
      agentName: d.name,
    }));

  async function handleVerifyToken() {
    setVerifying(true);
    setVerifyError('');
    try {
      const info = await window.api.messagingAppsVerifyTelegramToken(token.trim());
      setBotInfo(info);
      setConnectionName(`${info.firstName}'s Bot`);
      goNext();
    } catch (err) {
      setVerifyError((err as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  async function handleSave() {
    if (!selectedAgent || !botInfo) return;
    setSaving(true);
    setSaveError('');
    try {
      await createApp(
        {
          name: connectionName,
          type: 'telegram',
          enabled: true,
          globalDenyList: [],
          routing: [
            {
              id: `rule-${Date.now()}`,
              condition: { type: 'default' },
              targetAgentName: selectedAgent.agentName,
              allowList: [],
              denyList: [],
            },
          ],
        },
        token,
      );
      goNext(); // go to done step
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
    <div className="flex-1 overflow-y-auto p-8">
    <div className="mx-auto max-w-2xl">
      {/* Progress bar — only shown once a path is chosen */}
      {path && (
        <div className="mb-8 flex gap-1">
          {steps
            .filter((s) => s !== 'done')
            .map((s, i) => (
              <div
                key={s}
                className={`h-1 flex-1 rounded-full transition-colors ${i <= stepIndex ? 'bg-accent' : 'bg-card-hover'}`}
              />
            ))}
        </div>
      )}

      <div className="min-h-[360px]">
        {stepId === 'choose-path' && (
          <div>
            <h2 className="text-xl font-bold font-[family-name:var(--font-display)]">
              Connect Telegram
            </h2>
            <p className="mt-2 text-sm text-muted">
              By connecting Telegram, you or others can send messages to your agents.
            </p>
            <div className="mt-6 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => choosePath('new')}
                className="rounded-lg border-2 border-border px-5 py-4 text-left transition-colors hover:border-accent/50 hover:bg-card-hover"
              >
                <p className="font-medium">I'm new to Telegram</p>
                <p className="text-sm text-muted">
                  We'll explain everything and guide you step by step
                </p>
              </button>
              <button
                type="button"
                onClick={() => choosePath('know')}
                className="rounded-lg border-2 border-border px-5 py-4 text-left transition-colors hover:border-accent/50 hover:bg-card-hover"
              >
                <p className="font-medium">I know Telegram — help me create a bot</p>
                <p className="text-sm text-muted">Skip the basics, start with BotFather</p>
              </button>
              <button
                type="button"
                onClick={() => choosePath('token')}
                className="rounded-lg border-2 border-border px-5 py-4 text-left transition-colors hover:border-accent/50 hover:bg-card-hover"
              >
                <p className="font-medium">I already have a bot token</p>
                <p className="text-sm text-muted">Go straight to connecting your existing bot</p>
              </button>
            </div>
            <div className="mt-8">
              <button
                type="button"
                onClick={() => navigate({ to: '/messaging-apps' })}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
              >
                <ArrowLeft size={14} />
                Cancel
              </button>
            </div>
          </div>
        )}

        {stepId === 'what-is-telegram' && (
          <WizardStep title="What is Telegram?" onNext={goNext} onBack={goPrev}>
            <p className="text-base leading-relaxed text-foreground">
              <strong>Telegram</strong> is a free messaging app — similar to WhatsApp or iMessage —
              that works on your phone and computer.
            </p>
            <p className="mt-4 text-base leading-relaxed text-foreground">
              By connecting Telegram, you or others can send messages to your agents by simply
              opening a chat — just like texting a friend.
            </p>
            <p className="mt-4 text-base leading-relaxed text-foreground">
              Don't worry if you're not familiar with it — we'll guide you through every step.
            </p>
          </WizardStep>
        )}

        {stepId === 'what-is-bot' && (
          <WizardStep title="What is a Telegram Bot?" onNext={goNext} onBack={goPrev}>
            <p className="text-base leading-relaxed">
              A <strong>Bot</strong> is a special Telegram account that your AI assistant uses to
              receive messages — think of it like a virtual phone number just for your assistant.
            </p>
            <p className="mt-4 text-base leading-relaxed">
              When someone opens your bot's chat and sends a message, your AI assistant will read it
              and reply — automatically.
            </p>
            <div className="mt-5 rounded-lg border border-border bg-card-bg p-4 text-sm">
              <p className="font-medium">Good to know:</p>
              <ul className="mt-2 space-y-1 text-muted">
                <li>• Your bot gets its own unique name (ending in "bot")</li>
                <li>• You control who can message it</li>
                <li>• You can disable or delete it at any time</li>
              </ul>
            </div>
          </WizardStep>
        )}

        {stepId === 'open-botfather' && (
          <WizardStep
            title="Open BotFather"
            onNext={goNext}
            onBack={goPrev}
            nextLabel="I've opened BotFather"
          >
            <p className="text-base leading-relaxed">
              Telegram has an official tool called <strong>BotFather</strong> for creating bots. It
              lives inside Telegram itself.
            </p>
            <div className="mt-5 space-y-4">
              <Step number={1} text="Open Telegram on your phone or computer" />
              <Step number={2} text="In the search bar at the top, type: BotFather" />
              <Step
                number={3}
                text="Tap the result that has a blue checkmark — that's the official one"
              />
              <Step number={4} text='Tap the blue "START" button at the bottom' />
            </div>
            <div className="mt-4 rounded-lg border border-border bg-card-bg p-4 text-sm">
              <p className="font-medium">Tip: use Telegram on the web</p>
              <p className="mt-1 text-muted">
                Open Telegram at{' '}
                <button
                  type="button"
                  onClick={() => window.api.openExternal('https://web.telegram.org')}
                  className="text-accent hover:underline"
                >
                  web.telegram.org
                </button>{' '}
                — it makes it easier to copy and paste the token in the next step.
              </p>
            </div>
            <button
              type="button"
              onClick={() => window.api.openExternal('https://t.me/BotFather')}
              className="mt-5 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted hover:bg-card-hover hover:text-foreground"
            >
              <ExternalLink size={14} />
              Open BotFather in browser
            </button>
          </WizardStep>
        )}

        {stepId === 'create-bot' && (
          <WizardStep
            title="Create your bot"
            onNext={goNext}
            onBack={goPrev}
            nextLabel="I've created my bot"
          >
            <p className="text-base leading-relaxed">Inside BotFather, follow these steps:</p>
            <div className="mt-5 space-y-4">
              <Step number={1} text="/newbot and press Send" />
              <Step
                number={2}
                text='BotFather asks for a name. This is what people see — e.g. "My Assistant"'
              />
              <Step
                number={3}
                text='BotFather asks for a username. This must end in "bot" — e.g. "myassistant_bot"'
              />
              <Step number={4} text="BotFather will confirm your bot is created" />
            </div>
            <div className="mt-4 rounded-lg border border-border bg-card-bg p-4 text-sm text-muted">
              The username can't be changed later, but the display name can. Keep it simple.
            </div>
          </WizardStep>
        )}

        {stepId === 'copy-token' && (
          <WizardStep
            title="Copy your bot token"
            onNext={goNext}
            onBack={goPrev}
            nextLabel="I've copied the token"
          >
            <p className="text-base leading-relaxed">
              After creating your bot, BotFather shows you a long code called a{' '}
              <strong>token</strong>. This is the "key" that lets your assistant connect to your
              bot.
            </p>
            <div className="mt-4 rounded-lg border border-border bg-card-bg p-4 text-sm">
              <p className="font-medium text-foreground">Keep this code private</p>
              <p className="mt-1 text-muted">
                The token looks like:{' '}
                <code className="font-[family-name:var(--font-mono)] text-xs">
                  110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
                </code>
              </p>
              <p className="mt-2 text-muted">
                Copy the entire code — tap and hold it, then tap Copy.
              </p>
            </div>
            <p className="mt-4 text-sm text-muted">
              Don't worry if the message disappears — you can always ask BotFather for it again by
              sending <code className="font-[family-name:var(--font-mono)]">/mybots</code>.
            </p>
          </WizardStep>
        )}

        {stepId === 'paste-token' && (
          <WizardStep title="Paste your bot token" onNext={undefined} onBack={goPrev}>
            <p className="text-base leading-relaxed">
              Paste the token you copied from BotFather into the box below:
            </p>
            <div className="mt-5">
              <label
                htmlFor="bot-token"
                className="block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted mb-1"
              >
                Bot Token
              </label>
              <input
                id="bot-token"
                type="text"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setVerifyError('');
                }}
                placeholder="110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
                className="w-full rounded-lg border border-border bg-card-bg px-3 py-2 font-[family-name:var(--font-mono)] text-sm focus:border-accent focus:outline-none"
              />
              {verifyError && <p className="mt-2 text-sm text-red">Error: {verifyError}</p>}
              <p className="mt-2 text-xs text-muted">
                We'll verify the token is correct before continuing.
              </p>
            </div>
            <button
              type="button"
              onClick={handleVerifyToken}
              disabled={!token.trim() || verifying}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {verifying ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
              {verifying ? 'Verifying…' : 'Verify and continue'}
            </button>
          </WizardStep>
        )}

        {stepId === 'name-connection' && (
          <WizardStep
            title="Name this connection"
            onNext={connectionName.trim() ? goNext : undefined}
            onBack={goPrev}
          >
            {botInfo && (
              <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-green-tint p-3">
                <CheckCircle size={20} className="text-green" />
                <div>
                  <p className="text-sm font-medium text-green">Bot verified!</p>
                  <p className="text-xs text-muted">
                    @{botInfo.username} · {botInfo.firstName}
                  </p>
                </div>
              </div>
            )}
            <p className="text-base leading-relaxed">
              Give this connection a friendly name so you can recognise it later — something that
              describes what it's for.
            </p>
            <div className="mt-5">
              <label
                htmlFor="connection-name"
                className="block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted mb-1"
              >
                Connection Name
              </label>
              <input
                id="connection-name"
                type="text"
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder='e.g. "Customer Support Bot" or "Family Chat Bot"'
                className="w-full rounded-lg border border-border bg-card-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
            </div>
          </WizardStep>
        )}

        {stepId === 'choose-assistant' && (
          <WizardStep title="Choose your assistant" onNext={undefined} onBack={goPrev}>
            <p className="text-base leading-relaxed">
              Which AI assistant should handle messages sent to this bot?
            </p>
            {availableAgents.length === 0 ? (
              <div className="mt-4 rounded-lg border border-border bg-card-bg p-4 text-sm text-muted">
                No agents are running. Deploy an agent first, then come back here.
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-2">
                {availableAgents.map((a) => (
                  <button
                    key={`${a.deploymentId}-${a.agentName}`}
                    type="button"
                    onClick={() =>
                      setSelectedAgent({ deploymentId: a.deploymentId, agentName: a.agentName })
                    }
                    className={`rounded-lg border-2 px-4 py-3 text-left text-sm transition-colors ${
                      selectedAgent?.agentName === a.agentName &&
                      selectedAgent?.deploymentId === a.deploymentId
                        ? 'border-accent bg-accent/10'
                        : 'border-border hover:border-accent/50 hover:bg-card-hover'
                    }`}
                  >
                    <span className="font-medium">{a.label}</span>
                  </button>
                ))}
              </div>
            )}
            {selectedAgent && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
                {saving ? 'Connecting…' : 'Connect bot'}
              </button>
            )}
            {saveError && <p className="mt-3 text-sm text-red">Error: {saveError}</p>}
          </WizardStep>
        )}

        {stepId === 'done' && botInfo && (
          <div className="flex flex-col items-center py-12 text-center">
            <CheckCircle size={64} className="text-green" />
            <h2 className="mt-6 text-2xl font-bold font-[family-name:var(--font-display)]">
              You're all set!
            </h2>
            <p className="mt-3 text-base text-muted">
              Your Telegram bot <strong>@{botInfo.username}</strong> is now connected.
            </p>
            <button
              type="button"
              onClick={() => window.api.openExternal(`https://t.me/${botInfo.username}`)}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-accent hover:bg-card-hover"
            >
              <ExternalLink size={14} />
              t.me/{botInfo.username}
            </button>
            <button
              type="button"
              onClick={() => navigate({ to: '/messaging-apps' })}
              className="mt-6 rounded-lg bg-accent px-6 py-2 text-sm text-white hover:opacity-90"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
    </div>
    </div>
  );
}

// Shared step wrapper component
function WizardStep({
  title,
  children,
  onNext,
  onBack,
  nextLabel = 'Continue',
  backLabel = 'Back',
}: {
  title: string;
  children: React.ReactNode;
  onNext: (() => void) | undefined;
  onBack: () => void;
  nextLabel?: string;
  backLabel?: string;
}): JSX.Element {
  return (
    <div>
      <h2 className="text-xl font-bold font-[family-name:var(--font-display)]">{title}</h2>
      <div className="mt-4">{children}</div>
      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
        >
          <ArrowLeft size={14} />
          {backLabel}
        </button>
        {onNext && (
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white transition-colors hover:opacity-90"
          >
            {nextLabel}
            <ArrowRight size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function Step({ number, text }: { number: number; text: string }): JSX.Element {
  return (
    <div className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
        {number}
      </span>
      <p className="pt-0.5 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/new-telegram')({
  component: NewTelegramWizard,
});
