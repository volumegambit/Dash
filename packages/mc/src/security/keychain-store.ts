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

export interface KeychainStore {
  getGatewayToken(): Promise<string | null>;
  setGatewayToken(value: string): Promise<void>;
  getChatToken(): Promise<string | null>;
  setChatToken(value: string): Promise<void>;
  /**
   * Remove both gateway tokens from the OS credential store. Used by
   * explicit teardown (e.g. "Reset Gateway" in MC settings). Never
   * called during normal `ensureRunning()` flows — we prefer the
   * existing tokens across spawns so a restarted gateway stays
   * identity-compatible with prior state.
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

  async clearAllGatewayTokens(): Promise<void> {
    for (const account of [GATEWAY_TOKEN_ACCOUNT, CHAT_TOKEN_ACCOUNT]) {
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

  async clearAllGatewayTokens(): Promise<void> {
    this.store.delete(GATEWAY_TOKEN_ACCOUNT);
    this.store.delete(CHAT_TOKEN_ACCOUNT);
  }
}
