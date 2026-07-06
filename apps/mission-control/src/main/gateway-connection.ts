import type { GatewayConnectionSettings, RemoteGatewaySecrets } from '@dash/mc';
import type {
  GatewayConnectionStatus,
  GatewayConnectionTestResult,
  GatewayRelayConnectionInput,
} from '../shared/ipc.js';

export const REMOTE_GATEWAY_TEST_FAILURE =
  'Could not reach that gateway. Check the URL and tokens, then try again.';

export const RELAY_CREDENTIAL_HEADER = 'x-dash-relay-credential';

export interface NormalizedGatewayRelayConnection {
  profile: GatewayConnectionSettings;
  secrets: RemoteGatewaySecrets;
}

export interface GatewayRelayConnectionDeps {
  now(): string;
  checkRemoteGateway(
    profile: GatewayConnectionSettings,
    secrets: RemoteGatewaySecrets,
  ): Promise<void>;
  setRemoteGatewaySecrets(secrets: RemoteGatewaySecrets): Promise<void>;
  setGatewayConnection(profile: GatewayConnectionSettings): Promise<void>;
  refreshChatServiceConnection(): Promise<void>;
  getGatewayConnectionStatus(): Promise<GatewayConnectionStatus>;
}

export function localGatewayProfile(): GatewayConnectionSettings {
  return { mode: 'local' };
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function websocketBaseFromHttpBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return trimTrailingSlash(url.toString());
}

export function headersForRemoteGateway(secrets: RemoteGatewaySecrets): Record<string, string> {
  return secrets.relayCredential ? { [RELAY_CREDENTIAL_HEADER]: secrets.relayCredential } : {};
}

export function publicGatewayConnectionStatus(
  profile: GatewayConnectionSettings,
  hasRemoteSecrets: boolean,
  health: GatewayConnectionStatus['health'] = 'unknown',
): GatewayConnectionStatus {
  return { profile, hasRemoteSecrets, health };
}

export function normalizeGatewayRelayInput(
  input: GatewayRelayConnectionInput,
  now: string,
): NormalizedGatewayRelayConnection {
  const managementBaseUrl = trimTrailingSlash(input.managementBaseUrl.trim());
  if (!managementBaseUrl) throw new Error('Management URL is required');

  try {
    new URL(managementBaseUrl);
  } catch {
    throw new Error('Management URL is invalid');
  }

  const managementToken = input.managementToken.trim();
  if (!managementToken) throw new Error('Management token is required');

  const chatToken = input.chatToken.trim();
  if (!chatToken) throw new Error('Chat token is required');

  const chatBaseUrl = trimTrailingSlash(
    input.chatBaseUrl?.trim() || websocketBaseFromHttpBase(managementBaseUrl),
  );

  try {
    new URL(chatBaseUrl);
  } catch {
    throw new Error('Chat URL is invalid');
  }

  const profile: GatewayConnectionSettings = {
    mode: input.mode,
    name: input.name?.trim() || undefined,
    managementBaseUrl,
    chatBaseUrl,
    updatedAt: now,
  };

  const secrets: RemoteGatewaySecrets = {
    managementToken,
    chatToken,
    relayCredential: input.relayCredential?.trim() || undefined,
  };

  return { profile, secrets };
}

export async function testGatewayRelayConnection(
  input: GatewayRelayConnectionInput,
  deps: Pick<GatewayRelayConnectionDeps, 'now' | 'checkRemoteGateway'>,
): Promise<GatewayConnectionTestResult> {
  let normalized: NormalizedGatewayRelayConnection;
  try {
    normalized = normalizeGatewayRelayInput(input, deps.now());
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Connection details invalid',
    };
  }

  try {
    await deps.checkRemoteGateway(normalized.profile, normalized.secrets);
    return {
      ok: true,
      status: publicGatewayConnectionStatus(normalized.profile, true, 'healthy'),
    };
  } catch {
    return { ok: false, message: REMOTE_GATEWAY_TEST_FAILURE };
  }
}

export async function saveGatewayRelayConnection(
  input: GatewayRelayConnectionInput,
  deps: GatewayRelayConnectionDeps,
): Promise<GatewayConnectionStatus> {
  const normalized = normalizeGatewayRelayInput(input, deps.now());
  try {
    await deps.checkRemoteGateway(normalized.profile, normalized.secrets);
  } catch {
    throw new Error(REMOTE_GATEWAY_TEST_FAILURE);
  }

  await deps.setRemoteGatewaySecrets(normalized.secrets);
  await deps.setGatewayConnection(normalized.profile);
  await deps.refreshChatServiceConnection();
  return deps.getGatewayConnectionStatus();
}
