/**
 * Idempotent HTTP client for the relay's Bearer-gated `/admin/*` API.
 *
 * The control plane is the *sole* caller of this API: it provisions a pairing
 * credential, pushes it to the relay, and stores only the hash. The relay's
 * admin contract (see `@dash/relay`'s `createRelayServer`):
 *   POST /admin/pairings          { tenantId, gatewayId }                            → { credential }
 *   POST /admin/pairings/revoke   { tenantId, gatewayId, credential?|credentialHash? } → { ok: true }
 *   POST /admin/gateways/revoke   { tenantId, gatewayId }                            → { ok: true }
 *
 * Idempotency: provision is naturally additive; both revoke routes answer 200
 * even when the target is already absent, so retries are safe.
 */
export class RelayAdminClient {
  readonly #baseUrl: string;
  readonly #adminSecret: string;
  readonly #fetch: typeof fetch;

  /**
   * @param baseUrl Relay base URL, e.g. `https://relay.example.com`.
   * @param adminSecret Master secret presented as `Authorization: Bearer …`.
   * @param fetchImpl Injectable fetch (defaults to the global) for testing.
   */
  constructor(baseUrl: string, adminSecret: string, fetchImpl: typeof fetch = fetch) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#adminSecret = adminSecret;
    this.#fetch = fetchImpl;
  }

  /** Mint a pairing credential on the relay and return it (one-time). */
  async provisionPairing(tenantId: string, gatewayId: string): Promise<string> {
    const body = await this.#post('/admin/pairings', { tenantId, gatewayId });
    const credential = (body as { credential?: unknown }).credential;
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new Error('relay /admin/pairings did not return a credential');
    }
    return credential;
  }

  /**
   * Revoke a pairing credential. Pass `credentialHash` (the relay's base64url
   * SHA-256 digest) to drop exactly one device when only its hash is held — the
   * control plane's path, since it never keeps the raw secret. Pass `credential`
   * to revoke by raw value. With neither, every credential for the gateway is
   * revoked. Tolerates an already-absent target (idempotent).
   */
  async revokePairing(
    tenantId: string,
    gatewayId: string,
    credential?: string,
    credentialHash?: string,
  ): Promise<void> {
    await this.#post('/admin/pairings/revoke', { tenantId, gatewayId, credential, credentialHash });
  }

  /** Force-close the gateway's live tunnel (drops a revoked gateway at once). */
  async revokeGateway(tenantId: string, gatewayId: string): Promise<void> {
    await this.#post('/admin/gateways/revoke', { tenantId, gatewayId });
  }

  /** POST JSON to an admin route; throw on any non-2xx; return the parsed body. */
  async #post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#adminSecret}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`relay admin ${path} failed: ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    return res.json().catch(() => ({}));
  }
}
