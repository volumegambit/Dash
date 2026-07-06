import { CheckCircle2, Cloud, PlugZap, Server, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  GatewayConnectionStatus,
  GatewayRelayConnectionInput,
  McVpsGatewayDeployRequest,
} from '../../../shared/ipc.js';

type SaveMode = GatewayRelayConnectionInput['mode'];

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

function statusText(status: GatewayConnectionStatus | null): string {
  if (!status) return 'Checking...';
  const label =
    status.profile.mode === 'local'
      ? 'Local gateway'
      : status.profile.name || status.profile.managementBaseUrl || 'Remote gateway';
  return `${label} - ${status.health}`;
}

export function GatewayRuntimeSettings(): JSX.Element {
  const [status, setStatus] = useState<GatewayConnectionStatus | null>(null);
  const [relayForm, setRelayForm] = useState<GatewayRelayConnectionInput>(emptyRelayForm);
  const [vpsForm, setVpsForm] = useState<McVpsGatewayDeployRequest>(emptyVpsForm);
  const [busy, setBusy] = useState<'local' | 'relay' | 'vps' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await window.api.gatewayConnectionGet();
    setStatus(next);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const currentMode = status?.profile.mode ?? 'local';
  const currentEndpoint = useMemo(() => {
    if (!status?.profile.managementBaseUrl) return '127.0.0.1';
    return status.profile.managementBaseUrl;
  }, [status]);

  const run = async (
    kind: 'local' | 'relay' | 'vps',
    fn: () => Promise<GatewayConnectionStatus>,
  ): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      setStatus(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gateway update failed');
    } finally {
      setBusy(null);
    }
  };

  const saveRelay = (): Promise<void> =>
    run('relay', () =>
      window.api.gatewayConnectionSaveRelay({
        ...relayForm,
        name: cleanOptional(relayForm.name),
        chatBaseUrl: cleanOptional(relayForm.chatBaseUrl),
        relayCredential: cleanOptional(relayForm.relayCredential),
      }),
    );

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

  const useLocal = (): Promise<void> => run('local', () => window.api.gatewayConnectionUseLocal());

  const field =
    'min-h-9 rounded-md border border-border bg-card-bg px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-accent';
  const label = 'grid gap-1 text-[11px] font-medium text-muted';
  const button =
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted transition hover:bg-card-hover hover:text-foreground disabled:opacity-50';
  const primary =
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50';

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {currentMode === 'local' ? <Server size={15} /> : <Cloud size={15} />}
            <span data-testid="gateway-runtime-status" className="text-sm font-medium">
              {statusText(status)}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted">{currentEndpoint}</p>
        </div>
        <button type="button" onClick={useLocal} disabled={busy !== null} className={button}>
          <Unplug size={14} />
          Use local
        </button>
      </div>

      <div className="grid gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <PlugZap size={14} />
          Connect endpoint
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className={label}>
            Mode
            <select
              value={relayForm.mode}
              onChange={(e) => setRelayForm((f) => ({ ...f, mode: e.target.value as SaveMode }))}
              className={field}
            >
              <option value="relay">Relay</option>
              <option value="hosted">Hosted</option>
            </select>
          </label>
          <label className={label}>
            Name
            <input
              value={relayForm.name ?? ''}
              onChange={(e) => setRelayForm((f) => ({ ...f, name: e.target.value }))}
              className={field}
              placeholder="production-gateway"
            />
          </label>
          <label className={label}>
            Management URL
            <input
              value={relayForm.managementBaseUrl}
              onChange={(e) => setRelayForm((f) => ({ ...f, managementBaseUrl: e.target.value }))}
              className={field}
              placeholder="https://gw.relay.example.com"
            />
          </label>
          <label className={label}>
            Chat URL
            <input
              value={relayForm.chatBaseUrl ?? ''}
              onChange={(e) => setRelayForm((f) => ({ ...f, chatBaseUrl: e.target.value }))}
              className={field}
              placeholder="wss://gw.relay.example.com"
            />
          </label>
          <label className={label}>
            Management token
            <input
              type="password"
              value={relayForm.managementToken}
              onChange={(e) => setRelayForm((f) => ({ ...f, managementToken: e.target.value }))}
              className={field}
            />
          </label>
          <label className={label}>
            Chat token
            <input
              type="password"
              value={relayForm.chatToken}
              onChange={(e) => setRelayForm((f) => ({ ...f, chatToken: e.target.value }))}
              className={field}
            />
          </label>
          <label className={`${label} md:col-span-2`}>
            Relay credential
            <input
              type="password"
              value={relayForm.relayCredential ?? ''}
              onChange={(e) => setRelayForm((f) => ({ ...f, relayCredential: e.target.value }))}
              className={field}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={saveRelay}
          disabled={busy !== null}
          className={`${primary} w-fit`}
        >
          <CheckCircle2 size={14} />
          Save endpoint
        </button>
      </div>

      <div className="grid gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Server size={14} />
          Deploy to VPS
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className={label}>
            Host
            <input
              value={vpsForm.host}
              onChange={(e) => setVpsForm((f) => ({ ...f, host: e.target.value }))}
              className={field}
              placeholder="203.0.113.10"
            />
          </label>
          <label className={label}>
            User
            <input
              value={vpsForm.user ?? ''}
              onChange={(e) => setVpsForm((f) => ({ ...f, user: e.target.value }))}
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
                setVpsForm((f) => ({
                  ...f,
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
              onChange={(e) => setVpsForm((f) => ({ ...f, sshKeyPath: e.target.value }))}
              className={field}
              placeholder="~/.ssh/id_ed25519"
            />
          </label>
          <label className={label}>
            Gateway id
            <input
              value={vpsForm.gatewayId}
              onChange={(e) => setVpsForm((f) => ({ ...f, gatewayId: e.target.value }))}
              className={field}
              placeholder="alice-mbp"
            />
          </label>
          <label className={label}>
            Relay URL
            <input
              value={vpsForm.relayUrl}
              onChange={(e) => setVpsForm((f) => ({ ...f, relayUrl: e.target.value }))}
              className={field}
              placeholder="wss://relay.example.com"
            />
          </label>
          <label className={label}>
            Relay token
            <input
              type="password"
              value={vpsForm.relayToken}
              onChange={(e) => setVpsForm((f) => ({ ...f, relayToken: e.target.value }))}
              className={field}
            />
          </label>
          <label className={label}>
            VPS relay credential
            <input
              type="password"
              value={vpsForm.relayCredential ?? ''}
              onChange={(e) => setVpsForm((f) => ({ ...f, relayCredential: e.target.value }))}
              className={field}
            />
          </label>
          <label className={label}>
            Repo URL
            <input
              value={vpsForm.repoUrl ?? ''}
              onChange={(e) => setVpsForm((f) => ({ ...f, repoUrl: e.target.value }))}
              className={field}
              placeholder="https://github.com/volumegambit/Dash.git"
            />
          </label>
          <label className={label}>
            Branch
            <input
              value={vpsForm.branch ?? ''}
              onChange={(e) => setVpsForm((f) => ({ ...f, branch: e.target.value }))}
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
          <Cloud size={14} />
          {busy === 'vps' ? 'Deploying...' : 'Deploy and connect'}
        </button>
      </div>

      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}
