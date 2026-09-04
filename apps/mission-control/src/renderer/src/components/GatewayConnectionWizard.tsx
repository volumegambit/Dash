import { ArrowLeft, CheckCircle2, Cloud, Loader, PlugZap, Server, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  GatewayConnectionStatus,
  GatewayRelayConnectionInput,
  McVpsGatewayDeployRequest,
} from '../../../shared/ipc.js';

type WizardStep = 'choose' | 'existing' | 'vps';
type BusyState = 'local' | 'test' | 'save' | 'vps' | null;

const emptyRelayForm: GatewayRelayConnectionInput = {
  mode: 'relay',
  name: '',
  managementBaseUrl: '',
  chatBaseUrl: '',
  managementToken: '',
  chatToken: '',
  relayCredential: '',
};

const emptyVpsForm: McVpsGatewayDeployRequest = {
  host: '',
  user: '',
  sshPort: undefined,
  sshKeyPath: '',
  installDir: '',
  dataDir: '',
  repoUrl: '',
  branch: '',
  gatewayId: '',
  relayUrl: '',
  relayToken: '',
  managementToken: '',
  chatToken: '',
  relayCredential: '',
};

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : undefined;
}

function relayPayload(form: GatewayRelayConnectionInput): GatewayRelayConnectionInput {
  return {
    ...form,
    mode: 'relay',
    name: cleanOptional(form.name),
    chatBaseUrl: cleanOptional(form.chatBaseUrl),
    relayCredential: cleanOptional(form.relayCredential),
  };
}

function relaySignature(form: GatewayRelayConnectionInput): string {
  return JSON.stringify(relayPayload(form));
}

interface GatewayConnectionWizardProps {
  onConnected(status: GatewayConnectionStatus): void;
  onCancel?: () => void;
}

export function GatewayConnectionWizard({
  onConnected,
  onCancel,
}: GatewayConnectionWizardProps): JSX.Element {
  const [step, setStep] = useState<WizardStep>('choose');
  const [relayForm, setRelayForm] = useState<GatewayRelayConnectionInput>(emptyRelayForm);
  const [vpsForm, setVpsForm] = useState<McVpsGatewayDeployRequest>(emptyVpsForm);
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const [testedSignature, setTestedSignature] = useState<string | null>(null);

  const currentRelaySignature = useMemo(() => relaySignature(relayForm), [relayForm]);
  const relayTested = testedSignature === currentRelaySignature;

  const field =
    'min-h-9 rounded-md border border-border bg-card-bg px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-accent';
  const label = 'grid gap-1 text-[11px] font-medium text-muted';
  const button =
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted transition hover:bg-card-hover hover:text-foreground disabled:opacity-50';
  const primary =
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50';
  const option =
    'flex min-h-[76px] w-full items-center gap-3 rounded-md border border-border bg-card-bg px-3 text-left transition hover:border-accent hover:bg-card-hover';

  const updateRelay = (patch: Partial<GatewayRelayConnectionInput>): void => {
    setRelayForm((form) => ({ ...form, ...patch }));
    setTestedSignature(null);
    setError(null);
  };

  const run = async (
    kind: Exclude<BusyState, null>,
    fn: () => Promise<GatewayConnectionStatus>,
  ): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      onConnected(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gateway update failed');
    } finally {
      setBusy(null);
    }
  };

  const useLocal = (): Promise<void> => run('local', () => window.api.gatewayConnectionUseLocal());

  const testRelay = async (): Promise<void> => {
    setBusy('test');
    setError(null);
    setTestedSignature(null);
    try {
      const result = await window.api.gatewayConnectionTest(relayPayload(relayForm));
      if (result.ok) {
        setTestedSignature(currentRelaySignature);
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gateway connection test failed');
    } finally {
      setBusy(null);
    }
  };

  const saveRelay = (): Promise<void> =>
    run('save', () => window.api.gatewayConnectionSaveRelay(relayPayload(relayForm)));

  const deployVps = (): Promise<void> =>
    run('vps', () =>
      window.api.gatewayDeployVps({
        ...vpsForm,
        user: cleanOptional(vpsForm.user),
        sshKeyPath: cleanOptional(vpsForm.sshKeyPath),
        installDir: cleanOptional(vpsForm.installDir),
        dataDir: cleanOptional(vpsForm.dataDir),
        repoUrl: cleanOptional(vpsForm.repoUrl),
        branch: cleanOptional(vpsForm.branch),
        managementToken: cleanOptional(vpsForm.managementToken),
        chatToken: cleanOptional(vpsForm.chatToken),
        relayCredential: cleanOptional(vpsForm.relayCredential),
      }),
    );

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Choose a gateway</h3>
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} className={button}>
            Cancel
          </button>
        )}
      </div>

      {step === 'choose' && (
        <div className="grid gap-2">
          <button type="button" onClick={useLocal} disabled={busy !== null} className={option}>
            <Server size={18} className="shrink-0 text-accent" />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium text-foreground">Use this computer</span>
              <span className="text-xs text-muted">Local gateway</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setStep('existing')}
            disabled={busy !== null}
            className={option}
          >
            <PlugZap size={18} className="shrink-0 text-accent" />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium text-foreground">Connect existing gateway</span>
              <span className="text-xs text-muted">Relay URL and tokens</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setStep('vps')}
            disabled={busy !== null}
            className={option}
          >
            <Cloud size={18} className="shrink-0 text-accent" />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium text-foreground">Self-host on a VPS</span>
              <span className="text-xs text-muted">Advanced</span>
            </span>
          </button>
        </div>
      )}

      {step === 'existing' && (
        <div className="grid gap-3">
          <button type="button" onClick={() => setStep('choose')} className={`${button} w-fit`}>
            <ArrowLeft size={14} />
            Back
          </button>
          <div className="grid gap-3 md:grid-cols-2">
            <label className={label}>
              Gateway name
              <input
                value={relayForm.name ?? ''}
                onChange={(e) => updateRelay({ name: e.target.value })}
                className={field}
                placeholder="production-gateway"
              />
            </label>
            <label className={label}>
              Management URL
              <input
                value={relayForm.managementBaseUrl}
                onChange={(e) => updateRelay({ managementBaseUrl: e.target.value })}
                className={field}
                placeholder="https://gw.relay.example.com"
              />
            </label>
            <label className={label}>
              Chat URL
              <input
                value={relayForm.chatBaseUrl ?? ''}
                onChange={(e) => updateRelay({ chatBaseUrl: e.target.value })}
                className={field}
                placeholder="wss://gw.relay.example.com"
              />
            </label>
            <label className={label}>
              Management token
              <input
                type="password"
                value={relayForm.managementToken}
                onChange={(e) => updateRelay({ managementToken: e.target.value })}
                className={field}
              />
            </label>
            <label className={label}>
              Chat token
              <input
                type="password"
                value={relayForm.chatToken}
                onChange={(e) => updateRelay({ chatToken: e.target.value })}
                className={field}
              />
            </label>
            <label className={label}>
              Relay credential
              <input
                type="password"
                value={relayForm.relayCredential ?? ''}
                onChange={(e) => updateRelay({ relayCredential: e.target.value })}
                className={field}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={testRelay} disabled={busy !== null} className={button}>
              {busy === 'test' ? (
                <Loader size={14} className="animate-spin" />
              ) : (
                <ShieldCheck size={14} />
              )}
              Test connection
            </button>
            <button
              type="button"
              onClick={saveRelay}
              disabled={busy !== null || !relayTested}
              className={primary}
            >
              <CheckCircle2 size={14} />
              Use this gateway
            </button>
          </div>
          {relayTested && <p className="text-xs font-medium text-green">Connection looks good</p>}
        </div>
      )}

      {step === 'vps' && (
        <div className="grid gap-3">
          <button type="button" onClick={() => setStep('choose')} className={`${button} w-fit`}>
            <ArrowLeft size={14} />
            Back
          </button>
          <div className="grid gap-3 md:grid-cols-3">
            <label className={label}>
              Host
              <input
                value={vpsForm.host}
                onChange={(e) => setVpsForm((form) => ({ ...form, host: e.target.value }))}
                className={field}
                placeholder="203.0.113.10"
              />
            </label>
            <label className={label}>
              User
              <input
                value={vpsForm.user ?? ''}
                onChange={(e) => setVpsForm((form) => ({ ...form, user: e.target.value }))}
                className={field}
                placeholder="dash"
              />
            </label>
            <label className={label}>
              SSH port
              <input
                type="number"
                min={1}
                value={vpsForm.sshPort ?? ''}
                onChange={(e) =>
                  setVpsForm((form) => ({
                    ...form,
                    sshPort: e.target.value ? Number(e.target.value) : undefined,
                  }))
                }
                className={field}
                placeholder="22"
              />
            </label>
            <label className={label}>
              SSH key
              <input
                value={vpsForm.sshKeyPath ?? ''}
                onChange={(e) => setVpsForm((form) => ({ ...form, sshKeyPath: e.target.value }))}
                className={field}
                placeholder="~/.ssh/id_ed25519"
              />
            </label>
            <label className={label}>
              Gateway id
              <input
                value={vpsForm.gatewayId}
                onChange={(e) => setVpsForm((form) => ({ ...form, gatewayId: e.target.value }))}
                className={field}
                placeholder="alice-mbp"
              />
            </label>
            <label className={label}>
              Relay URL
              <input
                value={vpsForm.relayUrl}
                onChange={(e) => setVpsForm((form) => ({ ...form, relayUrl: e.target.value }))}
                className={field}
                placeholder="wss://relay.example.com"
              />
            </label>
            <label className={label}>
              Relay token
              <input
                type="password"
                value={vpsForm.relayToken}
                onChange={(e) => setVpsForm((form) => ({ ...form, relayToken: e.target.value }))}
                className={field}
              />
            </label>
            <label className={label}>
              VPS relay credential
              <input
                type="password"
                value={vpsForm.relayCredential ?? ''}
                onChange={(e) =>
                  setVpsForm((form) => ({ ...form, relayCredential: e.target.value }))
                }
                className={field}
              />
            </label>
            <label className={label}>
              Repo URL
              <input
                value={vpsForm.repoUrl ?? ''}
                onChange={(e) => setVpsForm((form) => ({ ...form, repoUrl: e.target.value }))}
                className={field}
                placeholder="https://github.com/volumegambit/Dash.git"
              />
            </label>
            <label className={label}>
              Branch
              <input
                value={vpsForm.branch ?? ''}
                onChange={(e) => setVpsForm((form) => ({ ...form, branch: e.target.value }))}
                className={field}
                placeholder="main"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={deployVps}
            disabled={busy !== null}
            className={`${primary} w-fit`}
          >
            {busy === 'vps' ? <Loader size={14} className="animate-spin" /> : <Cloud size={14} />}
            {busy === 'vps' ? 'Deploying...' : 'Deploy and connect'}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
