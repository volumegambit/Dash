import type { ChannelAdapter } from './types.js';

/**
 * Read-only view over the gateway's channel registry that adapter
 * factories can capture in closures. Telegram, for example, holds a
 * reference to this so its allow-list closure picks up PUT /channels
 * edits without restarting the bot. The interface deliberately exposes
 * only the fields any current adapter needs, so swapping in a different
 * registry implementation (tests, future backends) requires no changes
 * here.
 */
export interface ChannelRegistryReader {
  get(name: string): { allowedUsers: string[] } | undefined;
}

/**
 * Minimal credential read interface. The gateway passes a wrapper around
 * its encrypted credential store; tests can pass an in-memory stub.
 */
export interface ChannelCredentialReader {
  get(key: string): Promise<string | null>;
}

/**
 * Context handed to every {@link ChannelAdapterFactory.create} call.
 * Everything an adapter factory needs to construct a live
 * {@link ChannelAdapter} is threaded here — factories never reach
 * directly into module-scope state.
 */
export interface ChannelFactoryContext {
  /** Operator-chosen channel name (also used as the registry key). */
  channelName: string;
  /** Credential reader scoped to the gateway's encrypted store. */
  credentialStore: ChannelCredentialReader;
  /** Read-only access to the channel registry for pull-based reads. */
  channelRegistry: ChannelRegistryReader;
  /**
   * Gateway data directory. Adapters that need on-disk session state
   * (e.g. WhatsApp pairing data) should anchor paths under this directory
   * so multiple gateways with different data dirs don't collide.
   */
  dataDir: string;
}

/**
 * Thrown by {@link ChannelAdapterFactory.create} when a required
 * credential is missing from the credential store. The HTTP layer
 * converts this into a 400 response with a helpful message naming the
 * missing key.
 */
export class ChannelCredentialMissingError extends Error {
  constructor(public readonly credentialKey: string) {
    super(`No credential found for key '${credentialKey}'`);
    this.name = 'ChannelCredentialMissingError';
  }
}

/**
 * A factory describing how to construct one kind of channel adapter
 * (Telegram, WhatsApp, etc.). One factory instance per adapter type,
 * registered with {@link ChannelAdapterRegistry} at gateway startup.
 *
 * Adding a new channel adapter is a single new factory + one
 * `registry.register(...)` call — no edits to gateway boot, the
 * management API, or the channel restoration loop.
 */
export interface ChannelAdapterFactory {
  /**
   * Stable identifier used in `channels.json` and the POST /channels
   * body. Lowercase, no spaces. Adapters are looked up by this id.
   */
  readonly id: string;

  /** Human-readable label, surfaced in MC and logs. */
  readonly label: string;

  /**
   * Credential store keys this adapter needs, by logical name. Each
   * value maps a channel name to the credential key for that channel.
   * E.g. Telegram uses `{ token: (name) => \`channel:\${name}:token\` }`.
   *
   * Used today only as documentation/introspection; callers can derive
   * the exact keys an adapter expects without inspecting source.
   */
  readonly credentialKeys: Readonly<Record<string, (channelName: string) => string>>;

  /**
   * Build a live {@link ChannelAdapter} from credentials + context.
   * Called both on initial registration (POST /channels) and on gateway
   * boot when restoring persisted channels from `channels.json`.
   *
   * Throws {@link ChannelCredentialMissingError} when a required
   * credential is absent from the credential store.
   */
  create(context: ChannelFactoryContext): Promise<ChannelAdapter>;

  /**
   * Optional hook for hot credential rotation. Given a credential key
   * that was just rotated via PUT /credentials, return the channel name
   * this rotation affects, or `undefined` if this adapter doesn't care
   * about that key. The gateway will then stop the affected channel and
   * re-create it via {@link create}. Adapters that don't support hot
   * rotation simply omit this hook.
   */
  matchRotatedCredential?(credentialKey: string): string | undefined;
}

/**
 * Open registry of channel adapter factories. Replaces the previous
 * hardcoded `if (adapter === 'telegram') ... else if (adapter ===
 * 'whatsapp')` branches in the gateway's restore loop and management
 * API.
 *
 * Instances are intended to be constructed once at gateway startup and
 * passed wherever a factory might be looked up by id.
 */
export class ChannelAdapterRegistry {
  private factories = new Map<string, ChannelAdapterFactory>();

  /**
   * Register a factory. Throws if `factory.id` is already taken —
   * registration is a startup-time decision and silent overrides would
   * make the source of an adapter ambiguous.
   */
  register(factory: ChannelAdapterFactory): void {
    if (this.factories.has(factory.id)) {
      throw new Error(`Channel adapter '${factory.id}' is already registered`);
    }
    this.factories.set(factory.id, factory);
  }

  /** Look up a factory by id. Returns `undefined` for unknown ids. */
  get(id: string): ChannelAdapterFactory | undefined {
    return this.factories.get(id);
  }

  /** True if a factory with this id is registered. */
  has(id: string): boolean {
    return this.factories.has(id);
  }

  /** All registered factories, in registration order. */
  list(): readonly ChannelAdapterFactory[] {
    return [...this.factories.values()];
  }

  /**
   * Walk every factory's {@link ChannelAdapterFactory.matchRotatedCredential}
   * hook for a freshly-rotated credential key and return the affected
   * (factoryId, channelName) pair if any factory claims it, else
   * `undefined`. Used by the management API to dispatch the right
   * restart path when an operator updates a credential.
   */
  matchRotatedCredential(
    credentialKey: string,
  ): { factoryId: string; channelName: string } | undefined {
    for (const factory of this.factories.values()) {
      const channelName = factory.matchRotatedCredential?.(credentialKey);
      if (channelName) return { factoryId: factory.id, channelName };
    }
    return undefined;
  }
}
