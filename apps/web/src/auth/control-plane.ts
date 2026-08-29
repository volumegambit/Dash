import type { TokenSource } from '../api/rest';

/**
 * A gateway as returned by `GET /v1/gateways` (control plane). Property names
 * match `GatewayRecord` in `apps/relay-control-plane/src/store.ts` exactly —
 * note it's `gatewayId`, not `id`, and there is no `label` field (the
 * human-facing name IS `subdomain`).
 */
export interface GatewayInfo {
  gatewayId: string;
  subdomain: string;
  status: 'active' | 'revoked';
  createdAt: number;
}

/**
 * A paired device as returned by `GET /v1/gateways/:id/pairings`. Property
 * names match `PairingRecord` in `apps/relay-control-plane/src/store.ts`.
 * `deviceLabel` is nullable at the wire level (pairings may be created
 * without one).
 */
export interface PairingInfo {
  id: string;
  deviceLabel: string | null;
  clientKind: string;
}

/** Thrown for any non-2xx control-plane REST response. */
export class ControlPlaneApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(
      code ? `Control plane API error ${status} (${code})` : `Control plane API error ${status}`,
    );
    this.name = 'ControlPlaneApiError';
  }
}

/**
 * Joins `path` onto `baseUrl` without dropping or duplicating the base's own
 * path segments (mirrors `buildUrl` in `../api/rest.ts`).
 */
function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

/**
 * Control-plane error bodies shape errors as `{ error: string }` (see
 * `apps/relay-control-plane/src/api.ts`, e.g. `{ error: 'gateway not found' }`)
 * — unlike the mobile v1 surface's `{ code: string }`.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.json()) as { error?: unknown };
    return typeof data.error === 'string' ? data.error : undefined;
  } catch {
    return undefined;
  }
}

interface RequestOptions {
  body?: unknown;
}

/**
 * Thin `fetch` wrapper for the Dash relay control-plane REST surface used by
 * the browser client: listing/creating gateways is out of scope here (see
 * Task 12's GatewayPicker for gateway creation UI) — this covers listing
 * gateways and managing web-client pairings.
 */
export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listGateways(): Promise<GatewayInfo[]> {
    const { gateways } = await this.request<{ gateways: GatewayInfo[] }>('GET', '/v1/gateways');
    return gateways;
  }

  /** Mints a browser-session pairing credential. Always sends `clientKind: 'web'`. */
  createWebPairing(gatewayId: string, deviceLabel: string): Promise<{ credential: string }> {
    return this.request<{ credential: string }>(
      'POST',
      `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings`,
      { body: { deviceLabel, clientKind: 'web' } },
    );
  }

  async listPairings(gatewayId: string): Promise<PairingInfo[]> {
    const { pairings } = await this.request<{ pairings: PairingInfo[] }>(
      'GET',
      `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings`,
    );
    return pairings;
  }

  async deletePairing(gatewayId: string, pairingId: string): Promise<void> {
    await this.request<{ ok: true }>(
      'DELETE',
      `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings/${encodeURIComponent(pairingId)}`,
    );
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.tokens.getToken()}`,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      throw new ControlPlaneApiError(response.status, await readErrorCode(response));
    }

    return (await response.json()) as T;
  }
}
