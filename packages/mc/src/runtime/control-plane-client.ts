/**
 * HTTP client for the hosted control-plane API — Mission Control's *sole*
 * interface to the control plane. MC signs in (WorkOS, elsewhere), then uses
 * this client to enroll a gateway, refresh its dial token, and provision/revoke
 * device pairings. The control plane is the only party that talks to the relay
 * admin API server-side, so MC never holds the relay master secret.
 *
 * Every request carries `Authorization: Bearer <token>`, where the token is the
 * caller's control-plane session token (resolved lazily via `getToken` so an
 * expired/refreshed token is always current). A `null` token still sends the
 * request (the server answers 401, which surfaces as a thrown error) — the
 * caller decides whether to prompt for sign-in.
 *
 * Contract (`apps/relay-control-plane/src/api.ts`):
 *   POST   /v1/gateways {subdomain, publicKey} → { gatewayId, subdomain, dialToken }
 *   POST   /v1/gateways/:id/pairings          → { credential }
 *   GET    /v1/gateways                        → { gateways: GatewayRecord[] }
 *   GET    /v1/gateways/:id/pairings           → { pairings: PairingRecord[] }
 *   DELETE /v1/gateways/:id/pairings/:pid      → { ok: true }
 */

/** A freshly provisioned gateway: its id, public subdomain, and signed dial token. */
export interface GatewayProvision {
  gatewayId: string;
  dialToken: string;
  subdomain: string;
}

/** A device pairing as surfaced to the renderer (label may be absent). */
export interface GatewayDevice {
  id: string;
  label: string | null;
}

/** A gateway plus its active device pairings, owned by the signed-in account. */
export interface GatewaySummary {
  gatewayId: string;
  subdomain: string;
  devices: GatewayDevice[];
}

/** Mission Control's HTTP interface to the control plane (injectable for DI). */
export interface ControlPlaneClient {
  /** Enroll a new gateway for the signed-in account at a chosen subdomain. */
  createGateway(subdomain: string, publicKey: string): Promise<GatewayProvision>;
  /** Provision a one-time pairing credential for an owned gateway. */
  createPairing(gatewayId: string, deviceLabel?: string): Promise<{ credential: string }>;
  /** List the gateways the signed-in account owns, each with its devices. */
  listGateways(): Promise<GatewaySummary[]>;
  /** Revoke a single device pairing. */
  revokePairing(gatewayId: string, pairingId: string): Promise<void>;
}

/**
 * Build a {@link ControlPlaneClient} pointed at `baseUrl`.
 *
 * @param baseUrl   Control-plane origin, e.g. `https://cp.dash.example`.
 * @param getToken  Resolves the current session token (or `null` when signed out).
 * @param fetchImpl Injectable fetch (defaults to the global) for testing.
 */
export function createControlPlaneClient(
  baseUrl: string,
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): ControlPlaneClient {
  const base = baseUrl.replace(/\/+$/, '');

  /** Issue an authenticated request and parse the JSON body (throws on non-2xx). */
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `control plane ${method} ${path} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
      );
    }
    return (await res.json()) as T;
  }

  return {
    async createGateway(subdomain: string, publicKey: string): Promise<GatewayProvision> {
      const body = await request<Partial<GatewayProvision>>('POST', '/v1/gateways', {
        subdomain,
        publicKey,
      });
      if (
        typeof body.gatewayId !== 'string' ||
        typeof body.dialToken !== 'string' ||
        typeof body.subdomain !== 'string'
      ) {
        throw new Error('control plane: createGateway returned an incomplete response');
      }
      return { gatewayId: body.gatewayId, dialToken: body.dialToken, subdomain: body.subdomain };
    },

    async createPairing(gatewayId: string, deviceLabel?: string): Promise<{ credential: string }> {
      const body = await request<{ credential?: unknown }>(
        'POST',
        `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings`,
        deviceLabel !== undefined ? { deviceLabel } : {},
      );
      if (typeof body.credential !== 'string' || body.credential.length === 0) {
        throw new Error('control plane: createPairing returned no credential');
      }
      return { credential: body.credential };
    },

    async listGateways(): Promise<GatewaySummary[]> {
      const { gateways } = await request<{
        gateways: Array<{ gatewayId: string; subdomain: string }>;
      }>('GET', '/v1/gateways');
      // The list endpoint returns gateway records only; fan out to fetch each
      // gateway's pairings so the renderer gets a self-contained device list.
      return Promise.all(
        gateways.map(async (gw): Promise<GatewaySummary> => {
          const { pairings } = await request<{
            pairings: Array<{ id: string; deviceLabel: string | null }>;
          }>('GET', `/v1/gateways/${encodeURIComponent(gw.gatewayId)}/pairings`);
          return {
            gatewayId: gw.gatewayId,
            subdomain: gw.subdomain,
            devices: pairings.map((p) => ({ id: p.id, label: p.deviceLabel })),
          };
        }),
      );
    },

    async revokePairing(gatewayId: string, pairingId: string): Promise<void> {
      await request<unknown>(
        'DELETE',
        `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings/${encodeURIComponent(pairingId)}`,
      );
    },
  };
}
