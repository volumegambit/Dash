/**
 * Keychain-backed secret storage for MC's gateway tokens.
 *
 * The gateway management token and chat token used to live in plain
 * JSON inside `gateway-state.json`. We now keep them in the OS
 * credential store (macOS Keychain, Windows Credential Manager,
 * libsecret on Linux) via `@napi-rs/keyring`, so that a file-system
 * snapshot of MC's user data dir no longer exposes a working
 * management-plane credential.
 *
 * The interface is deliberately domain-specific (getGatewayToken /
 * setChatToken) rather than generic (get(account)) — there are only
 * ever two tokens, the call sites are few, and typo-safe method names
 * beat an unchecked string key.
 *
 * The default implementation is instantiated lazily: the native binding
 * is only loaded on first method call, not at module evaluation time.
 * This keeps `@dash/mc`'s other consumers (the gateway CLI, tests,
 * non-Electron Node scripts) from paying the cost of loading a native
 * module they never use.
 */

import type { Entry as KeytarEntry } from '@napi-rs/keyring';

const KEYCHAIN_SERVICE = 'dash-mission-control';
const GATEWAY_TOKEN_ACCOUNT = 'gateway-management-token';
const CHAT_TOKEN_ACCOUNT = 'gateway-chat-token';
const RELAY_TOKEN_ACCOUNT = 'gateway-relay-token';
const GATEWAY_ID_ACCOUNT = 'gateway-relay-id';
const RELAY_ADMIN_SECRET_ACCOUNT = 'gateway-relay-admin-secret';
const CONTROL_PLANE_TOKEN_ACCOUNT = 'control-plane-token';
const ISSUED_GATEWAY_ID_ACCOUNT = 'issued-gateway-id';
const ISSUED_GATEWAY_SUBDOMAIN_ACCOUNT = 'issued-gateway-subdomain';
const ISSUED_GATEWAY_HOST_ACCOUNT = 'issued-gateway-host';
const ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT = 'issued-gateway-dial-token';

/**
 * The gateway identity the hosted control plane issues at enrollment. The
 * gateway owns its own keypair (the private key never leaves the device), so MC
 * custodies only non-secret routing data: `gatewayId` (the user-chosen permanent
 * subdomain label, also the relay routing key), `subdomain` (the full
 * `<label>.<zone>` hostname phones pair to), and `host` (the relay's base zone).
 * `dialToken` is an optional spawn-time seed — the gateway refreshes its own
 * token, so this is not load-bearing. `gatewayId`, `subdomain`, and `host` are
 * all required for a usable record — see {@link KeychainStore.getIssuedGateway}.
 */
export interface IssuedGateway {
  gatewayId: string;
  subdomain: string;
  host: string;
  dialToken?: string;
}

export interface KeychainStore {
  getGatewayToken(): Promise<string | null>;
  setGatewayToken(value: string): Promise<void>;
  getChatToken(): Promise<string | null>;
  setChatToken(value: string): Promise<void>;
  /**
   * Relay admission secret the gateway presents on dial-in, and the stable
   * per-gateway id the relay routes by. Both persist here so a supervisor
   * restart reuses the same identity — phones pair to `<gatewayId>`, so it must
   * not change. Only populated once relay mode is configured.
   *
   * @deprecated Self-hosted relay path. The hosted control plane now issues the
   * gateway identity ({@link getIssuedGateway}); use that instead.
   */
  getRelayToken(): Promise<string | null>;
  /** @deprecated Self-hosted relay path — see {@link getIssuedGateway}. */
  setRelayToken(value: string): Promise<void>;
  /** @deprecated Self-hosted relay path — see {@link getIssuedGateway}. */
  getGatewayId(): Promise<string | null>;
  /** @deprecated Self-hosted relay path — see {@link getIssuedGateway}. */
  setGatewayId(value: string): Promise<void>;
  /**
   * Master secret for the relay's admin API. Mission Control presents it to
   * provision/revoke per-device pairing credentials. User-configured to match
   * the relay's RELAY_ADMIN_SECRET; a secret, so it lives here, not in settings.
   *
   * @deprecated Self-hosted relay path. With the hosted control plane MC never
   * holds the relay master secret — the control plane is the admin caller.
   */
  getRelayAdminSecret(): Promise<string | null>;
  /** @deprecated Self-hosted relay path — see {@link getRelayAdminSecret}. */
  setRelayAdminSecret(value: string): Promise<void>;
  /**
   * The hosted control plane's session access token (WorkOS-issued). MC sends
   * it as `Authorization: Bearer <token>` on every control-plane API call. A
   * secret, so it lives in the OS credential store, never in settings.json.
   */
  getControlPlaneToken(): Promise<string | null>;
  setControlPlaneToken(value: string): Promise<void>;
  /**
   * The gateway identity issued by the control plane at enrollment. Persisted
   * so a supervisor restart reuses the same `gatewayId` (phones pair to it).
   * Returns `null` unless all three fields are present — a partially written
   * record is treated as absent so `ensureRunning()` re-enrolls cleanly.
   */
  getIssuedGateway(): Promise<IssuedGateway | null>;
  setIssuedGateway(value: IssuedGateway): Promise<void>;
  /**
   * Remove all gateway secrets (management + chat tokens, relay token, gateway
   * id, relay admin secret, control-plane token, issued gateway record) from
   * the OS credential store. Used by explicit teardown (e.g. "Reset Gateway" in
   * MC settings). Never called during normal `ensureRunning()` flows — we prefer
   * the existing identity across spawns so a restarted gateway stays compatible
   * with prior state and paired phones.
   */
  clearAllGatewayTokens(): Promise<void>;
}

/**
 * Lazy-loaded reference to the `Entry` constructor from
 * `@napi-rs/keyring`. Cached across calls so we only pay the
 * `import()` cost once per process.
 */
let keytarEntryCtorPromise: Promise<typeof KeytarEntry> | null = null;
async function loadEntryCtor(): Promise<typeof KeytarEntry> {
  if (!keytarEntryCtorPromise) {
    keytarEntryCtorPromise = import('@napi-rs/keyring').then((mod) => mod.Entry);
  }
  return keytarEntryCtorPromise;
}

class DefaultKeychainStore implements KeychainStore {
  private entryCache = new Map<string, KeytarEntry>();

  private async entry(account: string): Promise<KeytarEntry> {
    const cached = this.entryCache.get(account);
    if (cached) return cached;
    const EntryCtor = await loadEntryCtor();
    const e = new EntryCtor(KEYCHAIN_SERVICE, account);
    this.entryCache.set(account, e);
    return e;
  }

  async getGatewayToken(): Promise<string | null> {
    return (await this.entry(GATEWAY_TOKEN_ACCOUNT)).getPassword();
  }

  async setGatewayToken(value: string): Promise<void> {
    (await this.entry(GATEWAY_TOKEN_ACCOUNT)).setPassword(value);
  }

  async getChatToken(): Promise<string | null> {
    return (await this.entry(CHAT_TOKEN_ACCOUNT)).getPassword();
  }

  async setChatToken(value: string): Promise<void> {
    (await this.entry(CHAT_TOKEN_ACCOUNT)).setPassword(value);
  }

  async getRelayToken(): Promise<string | null> {
    return (await this.entry(RELAY_TOKEN_ACCOUNT)).getPassword();
  }

  async setRelayToken(value: string): Promise<void> {
    (await this.entry(RELAY_TOKEN_ACCOUNT)).setPassword(value);
  }

  async getGatewayId(): Promise<string | null> {
    return (await this.entry(GATEWAY_ID_ACCOUNT)).getPassword();
  }

  async setGatewayId(value: string): Promise<void> {
    (await this.entry(GATEWAY_ID_ACCOUNT)).setPassword(value);
  }

  async getRelayAdminSecret(): Promise<string | null> {
    return (await this.entry(RELAY_ADMIN_SECRET_ACCOUNT)).getPassword();
  }

  async setRelayAdminSecret(value: string): Promise<void> {
    (await this.entry(RELAY_ADMIN_SECRET_ACCOUNT)).setPassword(value);
  }

  async getControlPlaneToken(): Promise<string | null> {
    return (await this.entry(CONTROL_PLANE_TOKEN_ACCOUNT)).getPassword();
  }

  async setControlPlaneToken(value: string): Promise<void> {
    (await this.entry(CONTROL_PLANE_TOKEN_ACCOUNT)).setPassword(value);
  }

  async getIssuedGateway(): Promise<IssuedGateway | null> {
    const gatewayId = await (await this.entry(ISSUED_GATEWAY_ID_ACCOUNT)).getPassword();
    const subdomain = await (await this.entry(ISSUED_GATEWAY_SUBDOMAIN_ACCOUNT)).getPassword();
    const host = await (await this.entry(ISSUED_GATEWAY_HOST_ACCOUNT)).getPassword();
    if (!gatewayId || !subdomain || !host) return null;
    const dialToken = await (await this.entry(ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT)).getPassword();
    return dialToken ? { gatewayId, subdomain, host, dialToken } : { gatewayId, subdomain, host };
  }

  async setIssuedGateway(value: IssuedGateway): Promise<void> {
    (await this.entry(ISSUED_GATEWAY_ID_ACCOUNT)).setPassword(value.gatewayId);
    (await this.entry(ISSUED_GATEWAY_SUBDOMAIN_ACCOUNT)).setPassword(value.subdomain);
    (await this.entry(ISSUED_GATEWAY_HOST_ACCOUNT)).setPassword(value.host);
    (await this.entry(ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT)).setPassword(value.dialToken ?? '');
  }

  async clearAllGatewayTokens(): Promise<void> {
    for (const account of [
      GATEWAY_TOKEN_ACCOUNT,
      CHAT_TOKEN_ACCOUNT,
      RELAY_TOKEN_ACCOUNT,
      GATEWAY_ID_ACCOUNT,
      RELAY_ADMIN_SECRET_ACCOUNT,
      CONTROL_PLANE_TOKEN_ACCOUNT,
      ISSUED_GATEWAY_ID_ACCOUNT,
      ISSUED_GATEWAY_SUBDOMAIN_ACCOUNT,
      ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT,
      ISSUED_GATEWAY_HOST_ACCOUNT,
    ]) {
      try {
        (await this.entry(account)).deletePassword();
      } catch {
        // Already absent — idempotent delete, no error to propagate.
      }
    }
  }
}

/**
 * Factory for the production keychain store. Callers should use this
 * rather than instantiating `DefaultKeychainStore` directly so the
 * class itself can stay internal — opens the door to swapping the
 * backing library without breaking consumers.
 */
export function createDefaultKeychainStore(): KeychainStore {
  return new DefaultKeychainStore();
}

/**
 * Map-backed keychain store for tests. No native dependency, no
 * persistence, no side effects. All methods resolve synchronously
 * (wrapped in `Promise.resolve`) to match the interface shape.
 */
export class InMemoryKeychainStore implements KeychainStore {
  private store = new Map<string, string>();

  async getGatewayToken(): Promise<string | null> {
    return this.store.get(GATEWAY_TOKEN_ACCOUNT) ?? null;
  }

  async setGatewayToken(value: string): Promise<void> {
    this.store.set(GATEWAY_TOKEN_ACCOUNT, value);
  }

  async getChatToken(): Promise<string | null> {
    return this.store.get(CHAT_TOKEN_ACCOUNT) ?? null;
  }

  async setChatToken(value: string): Promise<void> {
    this.store.set(CHAT_TOKEN_ACCOUNT, value);
  }

  async getRelayToken(): Promise<string | null> {
    return this.store.get(RELAY_TOKEN_ACCOUNT) ?? null;
  }

  async setRelayToken(value: string): Promise<void> {
    this.store.set(RELAY_TOKEN_ACCOUNT, value);
  }

  async getGatewayId(): Promise<string | null> {
    return this.store.get(GATEWAY_ID_ACCOUNT) ?? null;
  }

  async setGatewayId(value: string): Promise<void> {
    this.store.set(GATEWAY_ID_ACCOUNT, value);
  }

  async getRelayAdminSecret(): Promise<string | null> {
    return this.store.get(RELAY_ADMIN_SECRET_ACCOUNT) ?? null;
  }

  async setRelayAdminSecret(value: string): Promise<void> {
    this.store.set(RELAY_ADMIN_SECRET_ACCOUNT, value);
  }

  async getControlPlaneToken(): Promise<string | null> {
    return this.store.get(CONTROL_PLANE_TOKEN_ACCOUNT) ?? null;
  }

  async setControlPlaneToken(value: string): Promise<void> {
    this.store.set(CONTROL_PLANE_TOKEN_ACCOUNT, value);
  }

  async getIssuedGateway(): Promise<IssuedGateway | null> {
    const gatewayId = this.store.get(ISSUED_GATEWAY_ID_ACCOUNT);
    const subdomain = this.store.get(ISSUED_GATEWAY_SUBDOMAIN_ACCOUNT);
    const host = this.store.get(ISSUED_GATEWAY_HOST_ACCOUNT);
    if (!gatewayId || !subdomain || !host) return null;
    const dialToken = this.store.get(ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT);
    return dialToken ? { gatewayId, subdomain, host, dialToken } : { gatewayId, subdomain, host };
  }

  async setIssuedGateway(value: IssuedGateway): Promise<void> {
    this.store.set(ISSUED_GATEWAY_ID_ACCOUNT, value.gatewayId);
    this.store.set(ISSUED_GATEWAY_SUBDOMAIN_ACCOUNT, value.subdomain);
    this.store.set(ISSUED_GATEWAY_HOST_ACCOUNT, value.host);
    if (value.dialToken) this.store.set(ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT, value.dialToken);
    else this.store.delete(ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT);
  }

  async clearAllGatewayTokens(): Promise<void> {
    this.store.delete(GATEWAY_TOKEN_ACCOUNT);
    this.store.delete(CHAT_TOKEN_ACCOUNT);
    this.store.delete(RELAY_TOKEN_ACCOUNT);
    this.store.delete(RELAY_ADMIN_SECRET_ACCOUNT);
    this.store.delete(GATEWAY_ID_ACCOUNT);
    this.store.delete(CONTROL_PLANE_TOKEN_ACCOUNT);
    this.store.delete(ISSUED_GATEWAY_ID_ACCOUNT);
    this.store.delete(ISSUED_GATEWAY_SUBDOMAIN_ACCOUNT);
    this.store.delete(ISSUED_GATEWAY_DIAL_TOKEN_ACCOUNT);
    this.store.delete(ISSUED_GATEWAY_HOST_ACCOUNT);
  }
}
