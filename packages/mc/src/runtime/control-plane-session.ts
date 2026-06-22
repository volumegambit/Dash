/**
 * WorkOS sign-in for Mission Control via the standard desktop **loopback
 * redirect** OAuth flow:
 *
 *   1. Start a one-shot HTTP server on an ephemeral `127.0.0.1` port.
 *   2. Open the system browser to the WorkOS AuthKit authorize URL with
 *      `redirect_uri=http://127.0.0.1:<port>/callback`.
 *   3. The browser completes auth and is redirected back to the loopback
 *      server with `?code=…`. We resolve, close the server, and exchange the
 *      code for an access token.
 *   4. Persist the access token in the OS keychain (via the injected token
 *      store) so it survives MC restarts.
 *
 * The WorkOS specifics live entirely behind injected seams so this module —
 * and its unit test — needs no live WorkOS account and no real browser:
 *   - `buildAuthUrl(redirectUri)` produces the authorize URL
 *     (concretely `workos.userManagement.getAuthorizationUrl(...)`, wired in
 *     the Electron main process).
 *   - `openBrowser(url)` launches the system browser
 *     (concretely `shell.openExternal`, wired in main).
 *   - `exchangeCode(code)` swaps the returned code for an access token
 *     (concretely `workos.userManagement.authenticateWithCode(...)`).
 *
 * NOTE: the live browser round-trip and the real WorkOS `authenticateWithCode`
 * are exercised by **manual MC QA** (`apps/mission-control/TEST_PLAN.md`), not
 * by this unit test. CI only drives the injected seams.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Result of swapping a WorkOS authorization code for an access token. */
export interface TokenExchangeResult {
  /** The control-plane session access token (sent as `Authorization: Bearer`). */
  accessToken: string;
  /** Absolute expiry, in epoch milliseconds (compared against `now()`). */
  expiresAt: number;
}

/**
 * Single-string token persistence seam. Backed in production by the keychain
 * store's control-plane-token accessors (Task 3); a Map-backed fake in tests.
 */
export interface ControlPlaneSessionTokenStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

/** Injected dependencies — every WorkOS/browser/clock detail is a seam. */
export interface ControlPlaneSessionOptions {
  /** Persists the access token across MC restarts. */
  tokenStore: ControlPlaneSessionTokenStore;
  /** Builds the AuthKit authorize URL for the given loopback `redirect_uri`. */
  buildAuthUrl(redirectUri: string): string;
  /** Launches the system browser (concretely `shell.openExternal`). */
  openBrowser(url: string): Promise<void>;
  /** Swaps a returned authorization `code` for an access token. */
  exchangeCode(code: string): Promise<TokenExchangeResult>;
  /** Clock in epoch milliseconds (injectable for deterministic expiry tests). */
  now?: () => number;
}

/** Mission Control's hosted-control-plane sign-in session. */
export interface ControlPlaneSession {
  /**
   * Run the full loopback-OAuth flow: open the browser, await the redirect,
   * exchange the code, and persist the token. Resolves once a token is stored;
   * rejects on an OAuth error, a missing code, or a failed exchange.
   */
  signIn(): Promise<void>;
  /**
   * Resolve the current access token, silently refreshing through the loopback
   * flow when the in-memory token is at/near expiry. Returns `null` when signed
   * out. A token loaded from the store on a fresh process carries no expiry
   * metadata, so it is treated as live (a 401 upstream triggers re-sign-in).
   */
  getToken(): Promise<string | null>;
  /** Forget the persisted token (and the in-memory cache). */
  signOut(): Promise<void>;
}

/** Refresh this many ms before the recorded expiry to avoid edge races. */
const EXPIRY_SKEW_MS = 30_000;

/**
 * Build a {@link ControlPlaneSession}. All side effects (browser, WorkOS,
 * clock, persistence) are injected via {@link ControlPlaneSessionOptions}.
 */
export function createControlPlaneSession(opts: ControlPlaneSessionOptions): ControlPlaneSession {
  const now = opts.now ?? Date.now;

  // In-memory expiry for the token most recently minted *this* process. A token
  // restored from the store has no known expiry (cachedExpiresAt === null).
  let cachedExpiresAt: number | null = null;

  /** Run the loopback server + browser handshake; return the exchanged token. */
  async function runLoopbackFlow(): Promise<TokenExchangeResult> {
    const { code, close } = await new Promise<{ code: string; close: () => void }>(
      (resolve, reject) => {
        const server = http.createServer((req, res) => {
          // Only the callback path participates; ignore favicon etc. with 404.
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
          }
          const error = url.searchParams.get('error');
          const code = url.searchParams.get('code');
          if (error) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end(`Sign-in failed: ${error}`);
            reject(new Error(`control plane sign-in failed: ${error}`));
            return;
          }
          if (!code) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing authorization code');
            reject(new Error('control plane sign-in failed: no authorization code in callback'));
            return;
          }
          res
            .writeHead(200, { 'content-type': 'text/html' })
            .end('<html><body>Signed in. You can close this window.</body></html>');
          resolve({ code, close: () => server.close() });
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as AddressInfo;
          const redirectUri = `http://127.0.0.1:${port}/callback`;
          const authUrl = opts.buildAuthUrl(encodeURIComponent(redirectUri));
          // Fire-and-await the browser; surface a launch failure as a rejection.
          opts.openBrowser(authUrl).catch(reject);
        });
      },
    );

    try {
      return await opts.exchangeCode(code);
    } finally {
      // Close regardless of exchange outcome so the port is never leaked.
      close();
    }
  }

  /** Run sign-in, persist the token, and record its expiry in memory. */
  async function authenticate(): Promise<string> {
    const { accessToken, expiresAt } = await runLoopbackFlow();
    await opts.tokenStore.set(accessToken);
    cachedExpiresAt = expiresAt;
    return accessToken;
  }

  return {
    async signIn(): Promise<void> {
      await authenticate();
    },

    async getToken(): Promise<string | null> {
      const stored = await opts.tokenStore.get();
      if (stored === null) return null;
      // Only refresh when we have a known expiry for the live token and it is
      // within the skew window. A store-restored token (no expiry) is trusted.
      if (cachedExpiresAt !== null && now() >= cachedExpiresAt - EXPIRY_SKEW_MS) {
        return authenticate();
      }
      return stored;
    },

    async signOut(): Promise<void> {
      cachedExpiresAt = null;
      await opts.tokenStore.clear();
    },
  };
}
