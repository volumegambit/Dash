import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, CheckCircle, Loader } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDeploymentsStore } from '../../stores/deployments';

type StepId = 'intro' | 'scan-qr' | 'name-connection' | 'choose-assistant' | 'done';

const STEPS: StepId[] = ['intro', 'scan-qr', 'name-connection', 'choose-assistant', 'done'];

function NewWhatsAppWizard(): JSX.Element {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const appIdRef = useRef<string>(crypto.randomUUID().slice(0, 8));

  // scan-qr step state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState('');
  const [linked, setLinked] = useState(false);
  const [pairingAttempt, setPairingAttempt] = useState(0);

  // name-connection step
  const [connectionName, setConnectionName] = useState('My WhatsApp');

  // choose-assistant step
  const { deployments, loadDeployments } = useDeploymentsStore();
  const [selectedAgent, setSelectedAgent] = useState<{
    deploymentId: string;
    agentName: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    loadDeployments();
  }, [loadDeployments]);

  const stepId = STEPS[stepIndex];
  const goNext = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  const goPrev = () => setStepIndex((i) => Math.max(i - 1, 0));

  // Start pairing when entering scan-qr step
  // biome-ignore lint/correctness/useExhaustiveDependencies: pairingAttempt is intentionally used as a retry trigger
  useEffect(() => {
    if (stepId !== 'scan-qr' || linked) return;

    const appId = appIdRef.current;
    setPairingError('');
    setQrDataUrl(null);

    const unsub = window.api.whatsappOnQr((_, url) => setQrDataUrl(url));

    window.api
      .whatsappStartPairing(appId)
      .then(() => {
        setLinked(true);
        goNext();
      })
      .catch((err: Error) => setPairingError(err.message));

    return () => unsub();
  }, [stepId, pairingAttempt]);

  const availableAgents = deployments
    .filter((d) => d.status === 'running')
    .flatMap((d) =>
      Object.keys(d.config.agents ?? {}).map((agentName) => ({
        label: `${agentName} (${d.name})`,
        deploymentId: d.id,
        agentName,
      })),
    );

  async function handleSave() {
    if (!selectedAgent) return;
    setSaving(true);
    setSaveError('');
    try {
      await window.api.messagingAppsCreateWhatsApp(appIdRef.current, {
        name: connectionName,
        type: 'whatsapp',
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
      });
      goNext();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Progress bar */}
      <div className="mb-8 flex gap-1">
        {STEPS.filter((s) => s !== 'done').map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${i <= stepIndex ? 'bg-accent' : 'bg-card-hover'}`}
          />
        ))}
      </div>

      <div className="min-h-[360px]">
        {stepId === 'intro' && (
          <WizardStep
            title="Connect WhatsApp"
            onNext={goNext}
            onBack={() => navigate({ to: '/messaging-apps' })}
            backLabel="Cancel"
          >
            <p className="text-base leading-relaxed">
              Link your personal WhatsApp account so your AI assistant can receive and reply to
              messages — just like a regular contact.
            </p>
            <p className="mt-4 text-base leading-relaxed">
              This uses WhatsApp's <strong>Linked Devices</strong> feature — the same way WhatsApp
              Web works. No business account needed.
            </p>
            <div className="mt-5 rounded-lg border border-border bg-card-bg p-4 text-sm">
              <p className="font-medium">What you'll need:</p>
              <ul className="mt-2 space-y-1 text-muted">
                <li>• WhatsApp installed on your phone</li>
                <li>• Your phone nearby to scan a QR code</li>
              </ul>
            </div>
          </WizardStep>
        )}

        {stepId === 'scan-qr' && (
          <WizardStep
            title="Scan the QR code"
            onNext={linked ? goNext : undefined}
            onBack={goPrev}
            nextLabel="Continue"
          >
            {!linked && (
              <>
                <p className="text-base leading-relaxed">
                  Open WhatsApp on your phone →{' '}
                  <strong>Settings → Linked Devices → Link a Device</strong> → scan the code below.
                </p>
                <div className="mt-6 flex flex-col items-center">
                  {pairingError ? (
                    <div className="rounded-lg border border-border bg-red-tint p-4 text-sm text-red">
                      Error: {pairingError}
                      <button
                        type="button"
                        onClick={() => {
                          setPairingAttempt((prev) => prev + 1);
                        }}
                        className="mt-3 block rounded-lg bg-accent px-4 py-2 text-white hover:opacity-90"
                      >
                        Try again
                      </button>
                    </div>
                  ) : qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="WhatsApp QR Code"
                      className="h-56 w-56 rounded-lg border border-border"
                    />
                  ) : (
                    <div className="flex items-center gap-3 text-muted">
                      <Loader size={20} className="animate-spin" />
                      <span>Generating QR code…</span>
                    </div>
                  )}
                </div>
              </>
            )}
            {linked && (
              <div className="flex flex-col items-center py-8">
                <CheckCircle size={48} className="text-green" />
                <p className="mt-4 text-base font-medium">WhatsApp linked!</p>
                <p className="mt-1 text-sm text-muted">Click Continue to name this connection.</p>
              </div>
            )}
          </WizardStep>
        )}

        {stepId === 'name-connection' && (
          <WizardStep
            title="Name this connection"
            onNext={connectionName.trim() ? goNext : undefined}
            onBack={goPrev}
          >
            <p className="text-base leading-relaxed">
              Give this connection a name so you can recognise it later.
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
                placeholder='e.g. "Personal WhatsApp"'
                className="w-full rounded-lg border border-border bg-card-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
              />
            </div>
          </WizardStep>
        )}

        {stepId === 'choose-assistant' && (
          <WizardStep title="Choose your assistant" onNext={undefined} onBack={goPrev}>
            <p className="text-base leading-relaxed">
              Which AI assistant should handle WhatsApp messages?
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
                    {a.label}
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
                {saving ? 'Connecting…' : 'Connect WhatsApp'}
              </button>
            )}
            {saveError && <p className="mt-3 text-sm text-red">Error: {saveError}</p>}
          </WizardStep>
        )}

        {stepId === 'done' && (
          <div className="flex flex-col items-center py-12 text-center">
            <CheckCircle size={64} className="text-green" />
            <h2 className="mt-6 text-2xl font-bold font-[family-name:var(--font-display)]">
              WhatsApp connected!
            </h2>
            <p className="mt-3 text-base text-muted">
              Your assistant will now receive and reply to WhatsApp messages. Make sure your
              deployment is running.
            </p>
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
  );
}

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

export const Route = createFileRoute('/messaging-apps/new-whatsapp')({
  component: NewWhatsAppWizard,
});
