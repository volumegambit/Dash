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
 * the concrete Clerk OAuth details live — `@dash/mc`'s `ControlPlaneSession`
 * keeps Clerk, the browser, and the clock behind injected seams so its unit
 * tests need neither a live Clerk account nor an Electron runtime. Here we fill
 * those seams with the Clerk `/oauth/authorize` URL builder, a plain `fetch`
 * POST to `/oauth/token` (public client + PKCE, no client secret, no SDK),
 * `shell.openExternal`, and the keychain-backed token store.
 *
 * The live browser round-trip and the real Clerk token exchange are exercised by
 * manual MC QA (`apps/mission-control/TEST_PLAN.md`), not by CI.
 *
 * Configuration comes from the environment (deployment step, not code):
 *   - `DASH_CONTROL_PLANE_URL`    — control-plane API origin.
 *   - `DASH_CLERK_FRONTEND_API`   — Clerk Frontend API host (e.g. `foo.clerk.accounts.dev`).
 *   - `DASH_CLERK_CLIENT_ID`      — Clerk OAuth application client id (public).
 */

const DEFAULT_CONTROL_PLANE_URL = 'https://cp.dash.dev';

/**
 * The fixed loopback redirect URI. Must match the port the
 * `ControlPlaneSession` listens on AND the URI registered with the Clerk OAuth
 * app. OAuth requires the `redirect_uri` at the token exchange to be identical
 * to the one used at authorize, so it is pinned here rather than threaded
 * through `exchangeCode`.
 */
const REDIRECT_URI = 'http://127.0.0.1:53682/callback';

/**
 * The OIDC scopes MC requests. `offline_access` yields a refresh token.
 * `user:org:read` is REQUIRED: it is what makes Clerk attach the active
 * organization to the issued tokens (`org_id`). The control plane is
 * organizations-only and rejects any id_token without `org_id`, so without this
 * scope sign-in would fail with 401. (The OAuth application must also allow
 * `user:org:read`.)
 */
const SCOPES = 'openid profile email offline_access user:org:read';

/** Shape of Clerk's `/oauth/token` response (subset MC needs). */
interface ClerkTokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** How MC reads its control-plane configuration (env by default; injectable). */
export interface ControlPlaneConfig {
  baseUrl: string;
  clerkFrontendApi: string;
  clerkClientId: string;
}

export function readControlPlaneConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  return {
    baseUrl: env.DASH_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL,
    clerkFrontendApi: env.DASH_CLERK_FRONTEND_API ?? '',
    clerkClientId: env.DASH_CLERK_CLIENT_ID ?? '',
  };
}

/**
 * Build the concrete `exchangeCode` + `buildAuthUrl` seams over Clerk's OAuth
 * endpoints. No SDK is needed: authorize is plain URL building and the token
 * exchange is a single `fetch` POST (public client + PKCE). Exported (with an
 * injectable `fetch`/clock) so the mapping logic is unit-testable.
 */
export function makeClerkSeams(
  config: ControlPlaneConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): {
  buildAuthUrl: (redirectUri: string, state: string, codeChallenge: string) => string;
  exchangeCode: (code: string, codeVerifier: string) => Promise<TokenExchangeResult>;
} {
  const base = `https://${config.clerkFrontendApi}`;
  return {
    buildAuthUrl(redirectUri: string, state: string, codeChallenge: string): string {
      // `redirectUri` arrives already URL-encoded from the session's loopback
      // server; URLSearchParams re-encodes, so decode first to avoid
      // double-encoding.
      const decoded = safeDecode(redirectUri);
      const params = new URLSearchParams({
        client_id: config.clerkClientId,
        redirect_uri: decoded,
        response_type: 'code',
        scope: SCOPES,
        // CSRF guard — echoed back on the callback and verified by the session.
        state,
        // PKCE — Clerk's public client requires it.
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${base}/oauth/authorize?${params.toString()}`;
    },
    async exchangeCode(code: string, codeVerifier: string): Promise<TokenExchangeResult> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clerkClientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      });
      const res = await fetchImpl(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `control plane token exchange failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
        );
      }
      const json = (await res.json()) as ClerkTokenResponse;
      // MC sends the OIDC id_token as the control-plane Bearer: it carries the
      // org_id and aud=client_id the control plane's verifier requires.
      if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
        throw new Error('control plane token exchange returned no id_token');
      }
      // Clerk returns the lifetime in seconds; convert to an absolute epoch-ms
      // expiry for the session's skew check. Default to 1h when absent.
      const lifetimeSeconds = json.expires_in ?? 3600;
      return { accessToken: json.id_token, expiresAt: now() + lifetimeSeconds * 1000 };
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
  const seams = makeClerkSeams(opts.config);
  const session = createControlPlaneSession({
    tokenStore: opts.tokenStore,
    buildAuthUrl: seams.buildAuthUrl,
    openBrowser: opts.openBrowser ?? ((url) => shell.openExternal(url)),
    exchangeCode: seams.exchangeCode,
  });
  const client = createControlPlaneClient(opts.config.baseUrl, () => session.getToken());
  return { session, client };
}
