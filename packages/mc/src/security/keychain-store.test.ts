import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryKeychainStore, createDefaultKeychainStore } from './keychain-store.js';

// ---------------------------------------------------------------------------
// InMemoryKeychainStore — the test double itself. Assert it behaves
// correctly so tests elsewhere that use it can rely on its semantics.
// ---------------------------------------------------------------------------

describe('InMemoryKeychainStore', () => {
  let store: InMemoryKeychainStore;

  beforeEach(() => {
    store = new InMemoryKeychainStore();
  });

  it('returns null for unset gateway token', async () => {
    expect(await store.getGatewayToken()).toBeNull();
  });

  it('returns null for unset chat token', async () => {
    expect(await store.getChatToken()).toBeNull();
  });

  it('round-trips gateway token', async () => {
    await store.setGatewayToken('gw-secret-123');
    expect(await store.getGatewayToken()).toBe('gw-secret-123');
  });

  it('round-trips chat token', async () => {
    await store.setChatToken('chat-secret-456');
    expect(await store.getChatToken()).toBe('chat-secret-456');
  });

  it('keeps gateway and chat tokens independent', async () => {
    await store.setGatewayToken('g');
    await store.setChatToken('c');
    expect(await store.getGatewayToken()).toBe('g');
    expect(await store.getChatToken()).toBe('c');
  });

  it('overwrites existing token on set', async () => {
    await store.setGatewayToken('first');
    await store.setGatewayToken('second');
    expect(await store.getGatewayToken()).toBe('second');
  });

  it('clearAllGatewayTokens removes both tokens', async () => {
    await store.setGatewayToken('g');
    await store.setChatToken('c');
    await store.clearAllGatewayTokens();
    expect(await store.getGatewayToken()).toBeNull();
    expect(await store.getChatToken()).toBeNull();
  });

  it('clearAllGatewayTokens is idempotent on empty store', async () => {
    await expect(store.clearAllGatewayTokens()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DefaultKeychainStore — verify it wires each method to the right
// Entry call with the correct service/account pair. The native module
// is mocked via vi.mock so these tests don't touch the real OS keychain.
// ---------------------------------------------------------------------------

// Capture Entry constructor args so assertions can check service/account.
const entryConstructorCalls: Array<[string, string]> = [];
// Shared mock Entry instances keyed by `${service}/${account}`.
const mockEntryByKey = new Map<
  string,
  {
    password: string | null;
    getPassword: ReturnType<typeof vi.fn>;
    setPassword: ReturnType<typeof vi.fn>;
    deletePassword: ReturnType<typeof vi.fn>;
  }
>();

vi.mock('@napi-rs/keyring', () => {
  class MockEntry {
    private key: string;
    constructor(service: string, account: string) {
      entryConstructorCalls.push([service, account]);
      this.key = `${service}/${account}`;
      if (!mockEntryByKey.has(this.key)) {
        const state: {
          password: string | null;
          getPassword: ReturnType<typeof vi.fn>;
          setPassword: ReturnType<typeof vi.fn>;
          deletePassword: ReturnType<typeof vi.fn>;
        } = {
          password: null,
          // biome-ignore lint/style/noNonNullAssertion: state field initialized below
          getPassword: null!,
          // biome-ignore lint/style/noNonNullAssertion: state field initialized below
          setPassword: null!,
          // biome-ignore lint/style/noNonNullAssertion: state field initialized below
          deletePassword: null!,
        };
        state.getPassword = vi.fn(() => state.password);
        state.setPassword = vi.fn((v: string) => {
          state.password = v;
        });
        state.deletePassword = vi.fn(() => {
          state.password = null;
        });
        mockEntryByKey.set(this.key, state);
      }
    }
    getPassword(): string | null {
      // biome-ignore lint/style/noNonNullAssertion: key is always set in ctor
      return mockEntryByKey.get(this.key)!.getPassword();
    }
    setPassword(v: string): void {
      // biome-ignore lint/style/noNonNullAssertion: key is always set in ctor
      mockEntryByKey.get(this.key)!.setPassword(v);
    }
    deletePassword(): void {
      // biome-ignore lint/style/noNonNullAssertion: key is always set in ctor
      mockEntryByKey.get(this.key)!.deletePassword();
    }
  }
  return { Entry: MockEntry };
});

describe('DefaultKeychainStore', () => {
  beforeEach(() => {
    entryConstructorCalls.length = 0;
    mockEntryByKey.clear();
  });

  it('reads/writes gateway token under dash-mission-control/gateway-management-token', async () => {
    const store = createDefaultKeychainStore();
    await store.setGatewayToken('tok-42');
    expect(await store.getGatewayToken()).toBe('tok-42');

    expect(entryConstructorCalls).toContainEqual([
      'dash-mission-control',
      'gateway-management-token',
    ]);
  });

  it('reads/writes chat token under dash-mission-control/gateway-chat-token', async () => {
    const store = createDefaultKeychainStore();
    await store.setChatToken('chat-99');
    expect(await store.getChatToken()).toBe('chat-99');

    expect(entryConstructorCalls).toContainEqual(['dash-mission-control', 'gateway-chat-token']);
  });

  it('caches Entry instances per account so the native ctor runs once', async () => {
    const store = createDefaultKeychainStore();
    await store.setGatewayToken('a');
    await store.getGatewayToken();
    await store.setGatewayToken('b');
    await store.getGatewayToken();

    const managementCalls = entryConstructorCalls.filter(
      ([, account]) => account === 'gateway-management-token',
    );
    expect(managementCalls).toHaveLength(1);
  });

  it('clearAllGatewayTokens deletes both entries and survives re-deletion', async () => {
    const store = createDefaultKeychainStore();
    await store.setGatewayToken('g');
    await store.setChatToken('c');
    await store.clearAllGatewayTokens();
    expect(await store.getGatewayToken()).toBeNull();
    expect(await store.getChatToken()).toBeNull();
    // Second clear must not throw even though both slots are empty.
    await expect(store.clearAllGatewayTokens()).resolves.toBeUndefined();
  });
});
