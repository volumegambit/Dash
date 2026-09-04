import {
  type GatewayConnectionSettings,
  GatewayHttpError,
  type GatewayManagementClient,
  type RemoteGatewaySecrets,
} from '@dash/mc';
import type { GatewayIdentity, MobileCapability } from '@dash/mobile-contract';
import type {
  GatewayConnectionIssue,
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

export interface VerifiedGatewayMetadata {
  identity: GatewayIdentity | null;
  apiVersion: number;
  capabilities: MobileCapability[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryAfterFromGatewayError(error: GatewayHttpError): number | undefined {
  const details = error.apiError?.details;
  if (!isRecord(details)) return undefined;
  if (typeof details.retryAfterMs === 'number' && details.retryAfterMs >= 0) {
    return details.retryAfterMs;
  }
  if (typeof details.retryAfterSeconds === 'number' && details.retryAfterSeconds >= 0) {
    return details.retryAfterSeconds * 1_000;
  }
  return undefined;
}

export function classifyConversationGatewayFailure(error: unknown): GatewayConnectionIssue {
  if (error instanceof GatewayHttpError) {
    const code = error.apiError?.code;
    if (error.status === 401 || code === 'unauthorized') {
      return {
        kind: 'repair_required',
        message: 'Gateway authorization failed. Reconnect this gateway to continue.',
        retryable: false,
      };
    }
    if (error.status === 429 || code === 'rate_limited') {
      return {
        kind: 'rate_limited',
        message: error.apiError?.error ?? 'Gateway rate limit reached. Try again shortly.',
        retryable: error.apiError?.retryable ?? true,
        ...(retryAfterFromGatewayError(error) !== undefined
          ? { retryAfterMs: retryAfterFromGatewayError(error) }
          : {}),
      };
    }
    if (error.status === 426 || code === 'capability_required') {
      return {
        kind: 'update_required',
        message: `Update Dash: ${error.apiError?.error ?? 'the gateway requires a newer client'}`,
        retryable: error.apiError?.retryable ?? false,
      };
    }
    if (error.status >= 500 || code === 'gateway_offline') {
      return {
        kind: 'gateway_offline',
        message: 'Gateway offline — cached conversations are read-only.',
        retryable: true,
      };
    }
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
  ) {
    return {
      kind: 'gateway_offline',
      message: 'Gateway offline — cached conversations are read-only.',
      retryable: true,
    };
  }
  return {
    kind: 'update_required',
    message: `Update Dash: ${error instanceof Error ? error.message : String(error)}`,
    retryable: false,
  };
}

export interface GatewayRelayConnectionDeps {
  now(): string;
  checkRemoteGateway(
    profile: GatewayConnectionSettings,
    secrets: RemoteGatewaySecrets,
  ): Promise<VerifiedGatewayMetadata>;
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
  issue?: GatewayConnectionIssue,
): GatewayConnectionStatus {
  return { profile, hasRemoteSecrets, health, ...(issue ? { issue } : {}) };
}

export async function verifyConversationGateway(
  client: Pick<GatewayManagementClient, 'health' | 'getIdentity'>,
): Promise<VerifiedGatewayMetadata> {
  const health = await client.health();
  const apiVersion = health.apiVersion ?? 0;
  const capabilities = health.capabilities ?? [];
  if (!capabilities.includes('conversation-sync-v1')) {
    return { identity: null, apiVersion, capabilities };
  }
  const identity = await client.getIdentity();
  return { identity, apiVersion, capabilities };
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
  const verified = await deps
    .checkRemoteGateway(normalized.profile, normalized.secrets)
    .catch(() => {
      throw new Error(REMOTE_GATEWAY_TEST_FAILURE);
    });
  const profile: GatewayConnectionSettings = {
    ...normalized.profile,
    ...(verified.identity ? { gatewayId: verified.identity.gatewayId } : {}),
    apiVersion: verified.apiVersion,
    capabilities: verified.capabilities,
  };

  await deps.setRemoteGatewaySecrets(normalized.secrets);
  await deps.setGatewayConnection(profile);
  await deps.refreshChatServiceConnection();
  return deps.getGatewayConnectionStatus();
}
