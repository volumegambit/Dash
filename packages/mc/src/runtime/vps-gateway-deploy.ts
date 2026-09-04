import { spawn } from 'node:child_process';

export interface RelayConnectionUrls {
  managementBaseUrl: string;
  chatBaseUrl: string;
}

export interface VpsGatewayDeployRequest {
  host: string;
  user?: string;
  sshPort?: number;
  sshKeyPath?: string;
  installDir?: string;
  dataDir?: string;
  repoUrl?: string;
  branch?: string;
  gatewayId: string;
  relayUrl: string;
  relayToken: string;
  managementToken: string;
  chatToken: string;
}

export interface VpsGatewayDeployResult extends RelayConnectionUrls {
  name: string;
}

export interface SshRunner {
  run(args: string[], script: string): Promise<void>;
}

const DEFAULT_INSTALL_DIR = '~/.dash/vps-gateway/Dash';
const DEFAULT_DATA_DIR = '~/.dash/gateway';
const DEFAULT_REPO_URL = 'https://github.com/volumegambit/Dash.git';
const DEFAULT_BRANCH = 'main';

export function deriveRelayConnectionUrls(
  relayUrl: string,
  gatewayId: string,
): RelayConnectionUrls {
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error('Relay URL must be an absolute ws(s) or http(s) URL');
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Relay URL must use ws, wss, http, or https');
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(gatewayId)) {
    throw new Error('Gateway id must be a DNS-safe label');
  }

  const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
  const host = `${gatewayId}.${parsed.host}`;
  return {
    managementBaseUrl: `${secure ? 'https' : 'http'}://${host}`,
    chatBaseUrl: `${secure ? 'wss' : 'ws'}://${host}`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizedPath(value: string | undefined, fallback: string): string {
  return value?.trim() ? value.trim() : fallback;
}

export function buildVpsGatewayDeployScript(req: VpsGatewayDeployRequest): string {
  const installDir = normalizedPath(req.installDir, DEFAULT_INSTALL_DIR);
  const dataDir = normalizedPath(req.dataDir, DEFAULT_DATA_DIR);
  const repoUrl = normalizedPath(req.repoUrl, DEFAULT_REPO_URL);
  const branch = normalizedPath(req.branch, DEFAULT_BRANCH);
  const relayUrl = req.relayUrl.trim();
  const gatewayId = req.gatewayId.trim();

  if (!req.host.trim()) throw new Error('VPS host is required');
  if (!gatewayId) throw new Error('Gateway id is required');
  if (!relayUrl) throw new Error('Relay URL is required');
  if (!req.relayToken) throw new Error('Relay token is required');
  if (!req.managementToken) throw new Error('Management token is required');
  if (!req.chatToken) throw new Error('Chat token is required');

  return `#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=${shellQuote(installDir)}
DATA_DIR=${shellQuote(dataDir)}
REPO_URL=${shellQuote(repoUrl)}
BRANCH=${shellQuote(branch)}
GATEWAY_ID=${shellQuote(gatewayId)}
RELAY_URL=${shellQuote(relayUrl)}
RELAY_TOKEN=${shellQuote(req.relayToken)}
MANAGEMENT_TOKEN=${shellQuote(req.managementToken)}
CHAT_TOKEN=${shellQuote(req.chatToken)}

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 11; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 12; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 13; }

mkdir -p "$(dirname "$INSTALL_DIR")" "$DATA_DIR" "$HOME/.config/systemd/user"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  rm -rf "$INSTALL_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install
npm run build

cat > "$HOME/.config/systemd/user/dash-gateway.service" <<UNIT
[Unit]
Description=Dash Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) $INSTALL_DIR/apps/gateway/dist/index.js --management-port 9300 --channel-port 9200 --token $MANAGEMENT_TOKEN --chat-token $CHAT_TOKEN --data-dir $DATA_DIR --relay-url $RELAY_URL --relay-token $RELAY_TOKEN --gateway-id $GATEWAY_ID
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now dash-gateway.service
systemctl --user restart dash-gateway.service
systemctl --user --no-pager status dash-gateway.service
`;
}

function buildSshArgs(req: VpsGatewayDeployRequest): string[] {
  const userHost = req.user?.trim() ? `${req.user.trim()}@${req.host.trim()}` : req.host.trim();
  const args: string[] = [];
  if (req.sshPort) args.push('-p', String(req.sshPort));
  if (req.sshKeyPath?.trim()) args.push('-i', req.sshKeyPath.trim());
  args.push(userHost, 'bash -s');
  return args;
}

export const defaultSshRunner: SshRunner = {
  run(args: string[], script: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`SSH deployment failed${stderr ? `: ${stderr.trim()}` : ''}`));
        }
      });
      child.stdin.end(script);
    });
  },
};

export async function deployGatewayToVps(
  req: VpsGatewayDeployRequest,
  runner: SshRunner = defaultSshRunner,
): Promise<VpsGatewayDeployResult> {
  const script = buildVpsGatewayDeployScript(req);
  await runner.run(buildSshArgs(req), script);
  const urls = deriveRelayConnectionUrls(req.relayUrl, req.gatewayId);
  return {
    ...urls,
    name: req.gatewayId,
  };
}
