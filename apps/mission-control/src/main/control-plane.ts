import {
  type ControlPlaneClient,
  type ControlPlaneSession,
  type ControlPlaneSessionTokenStore,
  type TokenExchangeResult,
  createControlPlaneClient,
  createControlPlaneSession,
} from '@dash/mc';
import { shell } from 'electron';

/**
 * Main-process wiring for the hosted control plane. This is the one place where
 * the concrete WorkOS SDK lives — `@dash/mc`'s `ControlPlaneSession` keeps
 * WorkOS, the browser, and the clock behind injected seams so its unit tests
 * need neither a live WorkOS account nor an Electron runtime. Here we fill those
 * seams with the real `@workos-inc/node` client, `shell.openExternal`, and the
 * keychain-backed token store.
 *
 * The live browser round-trip and the real WorkOS `authenticateWithCode` are
 * exercised by manual MC QA (`apps/mission-control/TEST_PLAN.md`), not by CI.
 *
 * Configuration comes from the environment (deployment step, not code):
 *   - `DASH_CONTROL_PLANE_URL`  — control-plane API origin.
 *   - `DASH_WORKOS_CLIENT_ID`   — WorkOS AuthKit client id (public).
 *   - `DASH_WORKOS_API_KEY`     — WorkOS API key (used for the code exchange).
 */

const DEFAULT_CONTROL_PLANE_URL = 'https://cp.dash.dev';

/**
 * Minimal structural view of the WorkOS user-management surface MC uses. We
 * only need the code exchange — the AuthKit authorize URL is plain string
 * building, so `buildAuthUrl` constructs it directly (no SDK call, kept
 * synchronous for the session's loopback flow).
 */
interface WorkosUserManagement {
  authenticateWithCode(opts: {
    clientId: string;
    code: string;
  }): Promise<{ accessToken: string; expiresIn?: number }>;
}

interface WorkosLike {
  userManagement: WorkosUserManagement;
}

/** How MC reads its control-plane configuration (env by default; injectable). */
export interface ControlPlaneConfig {
  baseUrl: string;
  workosClientId: string;
  workosApiKey: string;
}

export function readControlPlaneConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  return {
    baseUrl: env.DASH_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL,
    workosClientId: env.DASH_WORKOS_CLIENT_ID ?? '',
    workosApiKey: env.DASH_WORKOS_API_KEY ?? '',
  };
}

/**
 * Build the concrete `exchangeCode` + `buildAuthUrl` seams over a WorkOS client.
 * Lazily imports `@workos-inc/node` so the native-free unit tests and the
 * gateway CLI never pay for it. Exported (with an injectable WorkOS factory) so
 * the mapping logic is unit-testable without the real SDK.
 */
export function makeWorkosSeams(
  config: ControlPlaneConfig,
  loadWorkos: () => Promise<WorkosLike> = defaultLoadWorkos(config.workosApiKey),
  now: () => number = Date.now,
): {
  buildAuthUrl: (redirectUri: string, state: string) => string;
  exchangeCode: (code: string) => Promise<TokenExchangeResult>;
} {
  return {
    buildAuthUrl(redirectUri: string, state: string): string {
      // `redirectUri` arrives already URL-encoded from the session's loopback
      // server; URLSearchParams re-encodes, so decode first to avoid
      // double-encoding. Built directly (no SDK) to keep this synchronous.
      const decoded = safeDecode(redirectUri);
      const params = new URLSearchParams({
        client_id: config.workosClientId,
        redirect_uri: decoded,
        response_type: 'code',
        provider: 'authkit',
        // CSRF guard — echoed back on the callback and verified by the session.
        state,
      });
      return `https://api.workos.com/user_management/authorize?${params.toString()}`;
    },
    async exchangeCode(code: string): Promise<TokenExchangeResult> {
      const workos = await loadWorkos();
      const result = await workos.userManagement.authenticateWithCode({
        clientId: config.workosClientId,
        code,
      });
      // WorkOS returns the lifetime in seconds; convert to an absolute epoch-ms
      // expiry for the session's skew check. Default to 1h when absent.
      const lifetimeSeconds = result.expiresIn ?? 3600;
      return { accessToken: result.accessToken, expiresAt: now() + lifetimeSeconds * 1000 };
    },
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function defaultLoadWorkos(apiKey: string): () => Promise<WorkosLike> {
  return async () => {
    const { WorkOS } = await import('@workos-inc/node');
    return new WorkOS(apiKey) as unknown as WorkosLike;
  };
}

/**
 * Assemble the control-plane session + client for the main process, using the
 * supervisor's keychain accessors as the token store. The same `getToken`
 * resolver feeds the client so every API call carries the current session
 * token (refreshing through the loopback flow near expiry).
 */
export function createControlPlaneRuntime(opts: {
  config: ControlPlaneConfig;
  tokenStore: ControlPlaneSessionTokenStore;
  openBrowser?: (url: string) => Promise<void>;
}): { session: ControlPlaneSession; client: ControlPlaneClient } {
  const seams = makeWorkosSeams(opts.config);
  const session = createControlPlaneSession({
    tokenStore: opts.tokenStore,
    buildAuthUrl: seams.buildAuthUrl,
    openBrowser: opts.openBrowser ?? ((url) => shell.openExternal(url)),
    exchangeCode: seams.exchangeCode,
  });
  const client = createControlPlaneClient(opts.config.baseUrl, () => session.getToken());
  return { session, client };
}
