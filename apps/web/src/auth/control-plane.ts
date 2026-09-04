import type { TokenSource } from '../api/rest';

/** Same capability id `apps/relay-control-plane/src/api.ts` and Mission
 * Control's `control-plane-client.ts` use for the pairing route that returns
 * `pairingId` (and, for `clientKind: 'web'`, `chatToken`). */
const PAIRING_ID_CAPABILITY = 'pairing-id-v1';

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
  /** Revoked rows are kept forever by the control plane, so a listing mixes
   * live and dead devices — never assume everything returned is usable.
   * `'pending'` (Task 4) is a signer-gated web mint awaiting an iOS signer's
   * decision — see `WebPairingPending`/`PendingApproval`; a denied or expired
   * one is hard-deleted server-side rather than transitioned to a status, so
   * it simply disappears from this list instead of ever reading `'pending'`
   * → something else here. */
  status: 'active' | 'revoked' | 'pending';
}

/** `createWebPairing` result when the account has zero registered signers
 * (or the pairing predates signer-gating): the credential and chat token are
 * minted and returned immediately, exactly like every pre-Task-3 mint. */
export interface WebPairingActive {
  status: 'active';
  credential: string;
  pairingId: string;
  chatToken: string;
}

/** `createWebPairing` result when the account is signer-gated (Task 3): no
 * credential, no chat token — both are withheld until a registered iOS
 * signer approves the `approvalId` (see `PendingApproval`, which renders it
 * as a `dash-approve:v1:<approvalId>` QR) and the web app claims them via
 * `claimCredential`. */
export interface WebPairingPending {
  status: 'pending';
  pairingId: string;
  approvalId: string;
  /** Unix milliseconds — the deadline `PendingApproval`'s countdown counts
   * down to and the poll loop gives up at. */
  approvalExpiresAt: number;
}

export type WebPairingResult = WebPairingActive | WebPairingPending;

/** `claimCredential` result — a discriminated union over `status` mirroring
 * the control plane's three outcomes for `POST .../pairings/:pid/credential`:
 * `'ok'` (200, single-use — the credential is scrubbed server-side right
 * after), `'pending'` (409 — the approval hasn't been decided yet; the
 * poll-and-retry signal, not an error), and `'gone'` (410 — covers an
 * already-claimed, expired, or revoked pairing alike; the control plane does
 * not distinguish these on the wire). */
export type ClaimCredentialResult =
  | { status: 'ok'; credential: string; chatToken: string }
  | { status: 'pending' }
  | { status: 'gone' };

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
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    // ^ never store bare `fetch`: calling it as a method rebinds `this` and real
    //   browsers throw "Illegal invocation" (tests always inject, so only live use hit it)
  ) {}

  async listGateways(): Promise<GatewayInfo[]> {
    const { gateways } = await this.request<{ gateways: GatewayInfo[] }>('GET', '/v1/gateways');
    return gateways;
  }

  /**
   * Mints a browser-session pairing via the `pairing-id-v1` capability route
   * (not the legacy `/pairings` route) — only that route returns `pairingId`,
   * and always sends `clientKind: 'web'`, which is what makes the control
   * plane resolve and return the gateway's registered `chatToken` (the
   * mobile-v1 bearer the browser needs — see `MobileRestClient`/`ChatSocket`)
   * on the `'active'` branch. Throws `ControlPlaneApiError` with
   * `status === 409` if the gateway hasn't registered a chat token yet (i.e.
   * needs to be re-enrolled from Mission Control since chat-token delivery
   * shipped) — see `GatewayPicker`, which turns that into a user-facing
   * message.
   *
   * Returns `WebPairingPending` instead, on a signer-gated account (Task 3):
   * see that type's doc and `PendingApproval` for the QR/poll/claim flow that
   * follows.
   */
  createWebPairing(gatewayId: string, deviceLabel: string): Promise<WebPairingResult> {
    return this.request<WebPairingResult>(
      'POST',
      `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings/${PAIRING_ID_CAPABILITY}`,
      { body: { deviceLabel, clientKind: 'web' } },
    );
  }

  /**
   * Claims the single-use credential (+ chat token) an approved, signer-
   * gated pairing is holding. Unlike every other method here, the control
   * plane's expected non-2xx outcomes (409 "not decided yet", 410 "already
   * claimed/expired/revoked") are surfaced as a `ClaimCredentialResult`
   * rather than a thrown `ControlPlaneApiError` — `PendingApproval`'s poll
   * loop calls this on every tick once it sees `'active'`, and both of those
   * are routine, not exceptional. Any other status (e.g. 404 unknown
   * pairing) still throws.
   */
  async claimCredential(gatewayId: string, pairingId: string): Promise<ClaimCredentialResult> {
    try {
      const body = await this.request<{ credential: string; chatToken: string }>(
        'POST',
        `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings/${encodeURIComponent(pairingId)}/credential`,
      );
      return { status: 'ok', credential: body.credential, chatToken: body.chatToken };
    } catch (err) {
      if (err instanceof ControlPlaneApiError && err.status === 409) return { status: 'pending' };
      if (err instanceof ControlPlaneApiError && err.status === 410) return { status: 'gone' };
      throw err;
    }
  }

  /**
   * Looks up a single pairing's current `status` via `listPairings` —
   * `PendingApproval`'s poll loop uses this rather than a dedicated
   * single-pairing route (there isn't one). Returns `undefined` if the
   * pairing has disappeared: a denied or swept-expired approval's pairing
   * row is hard-deleted server-side (see `PairingInfo.status`'s doc), not
   * transitioned to some other status, so "gone from the list" IS the
   * decline/expiry signal here.
   */
  async getPairingStatus(
    gatewayId: string,
    pairingId: string,
  ): Promise<PairingInfo['status'] | undefined> {
    const pairings = await this.listPairings(gatewayId);
    return pairings.find((pairing) => pairing.id === pairingId)?.status;
  }

  /** Live pairings only. The control plane never deletes a revoked row, so
   *  they are filtered here rather than in each consumer. */
  async listPairings(gatewayId: string): Promise<PairingInfo[]> {
    const { pairings } = await this.request<{ pairings: PairingInfo[] }>(
      'GET',
      `/v1/gateways/${encodeURIComponent(gatewayId)}/pairings`,
    );
    return pairings.filter((pairing) => pairing.status !== 'revoked');
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
