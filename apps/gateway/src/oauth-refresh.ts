import type { GatewayCredentialStore } from './credential-store.js';

/** A refreshed OAuth token set, as returned by a provider's refresh endpoint. */
export interface OAuthTokenSet {
  access: string;
  refresh: string;
  /** Absolute expiry as epoch milliseconds. */
  expires: number;
}

/** Exchanges a refresh token for a new token set. Throws on failure. */
export type OAuthRefresher = (refreshToken: string) => Promise<OAuthTokenSet>;

export interface OAuthRefreshLogger {
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

export interface OAuthRefreshDeps {
  /** Map of provider id → refresh function (the real ones hit OAuth HTTP endpoints). */
  refreshers?: Record<string, OAuthRefresher>;
  /** Clock injection point for tests. */
  now?: () => number;
  /** Refresh when the token expires within this many ms (default 30 min). */
  marginMs?: number;
  logger?: OAuthRefreshLogger;
}

const DEFAULT_MARGIN_MS = 30 * 60 * 1000;
const REFRESH_KEY_RE = /^(.+)-oauth-refresh:(.+)$/;

/**
 * Keeps OAuth access tokens in the credential store fresh.
 *
 * OAuth credentials are stored across three slots per provider+key:
 *   {provider}-api-key:{keyName}        → access token (consumed by the agent)
 *   {provider}-oauth-refresh:{keyName}  → refresh token (rotates on each refresh)
 *   {provider}-oauth-expires:{keyName}  → absolute expiry, epoch ms (string)
 *
 * `refreshExpiring()` refreshes any credential within `marginMs` of expiry and
 * persists the rotated tokens back to the store. Dash is the sole refresher —
 * pi-ai is handed an already-fresh token and never refreshes on its own (which
 * would rotate the refresh token behind our back and desync the store).
 */
export class OAuthRefreshCoordinator {
  private readonly refreshers: Record<string, OAuthRefresher>;
  private readonly now: () => number;
  private readonly marginMs: number;
  private readonly logger?: OAuthRefreshLogger;
  /** In-flight refreshes keyed by `provider:keyName` (single-flight dedupe). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: GatewayCredentialStore,
    deps: OAuthRefreshDeps = {},
  ) {
    this.refreshers = deps.refreshers ?? {};
    this.now = deps.now ?? (() => Date.now());
    this.marginMs = deps.marginMs ?? DEFAULT_MARGIN_MS;
    this.logger = deps.logger;
  }

  /** Refresh and persist every stored OAuth credential that is near expiry. */
  async refreshExpiring(): Promise<void> {
    const keys = await this.store.list();
    for (const key of keys) {
      const match = key.match(REFRESH_KEY_RE);
      if (!match) continue;
      await this.refreshOne(match[1], match[2]);
    }
  }

  private async refreshOne(provider: string, keyName: string): Promise<void> {
    const expiresRaw = await this.store.get(`${provider}-oauth-expires:${keyName}`);
    const expires = expiresRaw ? Number(expiresRaw) : Number.NaN;
    // A finite expiry comfortably in the future means the token is still fresh.
    // A missing/unparseable expiry falls through to a refresh (self-healing).
    if (Number.isFinite(expires) && this.now() < expires - this.marginMs) {
      return;
    }

    // Single-flight: if a refresh for this credential is already running (e.g. a
    // concurrent chat turn), await it instead of starting a second one — a double
    // refresh would rotate the refresh token twice and desync the store.
    const flightKey = `${provider}:${keyName}`;
    const existing = this.inflight.get(flightKey);
    if (existing) {
      await existing;
      return;
    }

    const promise = this.doRefresh(provider, keyName);
    this.inflight.set(flightKey, promise);
    try {
      await promise;
    } finally {
      this.inflight.delete(flightKey);
    }
  }

  private async doRefresh(provider: string, keyName: string): Promise<void> {
    const refresher = this.refreshers[provider];
    if (!refresher) {
      this.logger?.warn?.(`[oauth-refresh] No refresher for provider "${provider}"; skipping`);
      return;
    }

    const refreshToken = await this.store.get(`${provider}-oauth-refresh:${keyName}`);
    if (!refreshToken) return;

    let next: OAuthTokenSet;
    try {
      next = await refresher(refreshToken);
    } catch (err) {
      // Leave the stale credentials in place: the agent's next call will fail
      // with a 401, surfacing the existing re-auth path in the UI. Swallowing
      // here also keeps one provider's failure from blocking the others.
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error?.(`[oauth-refresh] Refresh failed for ${provider}:${keyName}: ${message}`);
      return;
    }

    await this.store.set(`${provider}-api-key:${keyName}`, next.access);
    await this.store.set(`${provider}-oauth-refresh:${keyName}`, next.refresh);
    await this.store.set(`${provider}-oauth-expires:${keyName}`, String(next.expires));
  }
}
