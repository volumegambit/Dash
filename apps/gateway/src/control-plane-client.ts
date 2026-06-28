import type { GatewayIdentity } from './gateway-identity.js';

/** Minimal `fetch` surface so tests can inject a fake without a real network. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ControlPlaneClientOptions {
  /** Base URL of the control plane, e.g. `https://cp.example.com` (no path). */
  controlPlaneUrl: string;
  /** This gateway's id (the subdomain label); embedded in the assertion. */
  gatewayId: string;
  /** Source of the short-lived `cp-dial-token` assertion. */
  identity: Pick<GatewayIdentity, 'signCpAssertion'>;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

export interface ControlPlaneClient {
  /** Mint a fresh dial token via a gateway-signed assertion. Throws on failure. */
  refreshDialToken(): Promise<string>;
}

/**
 * Gateway-local client for the control plane's `POST /gw/dial-token` refresh
 * endpoint. Unlike MC's control-plane client, this authenticates with a
 * holder-of-key assertion (no Clerk session) — the gateway owns its own
 * refresh. The caller (`DialTokenManager`) handles retries/backoff; this stays
 * a thin request that either returns a token or throws.
 */
export function createControlPlaneClient(opts: ControlPlaneClientOptions): ControlPlaneClient {
  const base = opts.controlPlaneUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init) as never);

  return {
    async refreshDialToken(): Promise<string> {
      const assertion = opts.identity.signCpAssertion(opts.gatewayId);
      const res = await doFetch(`${base}/gw/dial-token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${assertion}` },
      });
      if (!res.ok) {
        throw new Error(`control plane refresh failed: ${res.status}`);
      }
      const body = (await res.json()) as { dialToken?: unknown };
      if (typeof body.dialToken !== 'string' || body.dialToken.length === 0) {
        throw new Error('control plane refresh returned no dialToken');
      }
      return body.dialToken;
    },
  };
}
