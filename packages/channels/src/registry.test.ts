import { describe, expect, it } from 'vitest';
import { createDefaultChannelAdapterRegistry } from './default-registry.js';
import {
  type ChannelAdapterFactory,
  ChannelAdapterRegistry,
  ChannelCredentialMissingError,
  type ChannelFactoryContext,
} from './registry.js';
import type { ChannelAdapter, ChannelHealth, MessageHandler, OutboundMessage } from './types.js';

/** Minimal in-memory adapter the factories below return. */
class FakeAdapter implements ChannelAdapter {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  send(_conversationId: string, _message: OutboundMessage): Promise<void> {
    return Promise.resolve();
  }
  onMessage(_handler: MessageHandler): void {}
  getHealth(): ChannelHealth {
    return 'connected';
  }
  onHealthChange(_handler: (h: ChannelHealth) => void): void {}
}

function makeContext(channelName: string): ChannelFactoryContext {
  return {
    channelName,
    credentialStore: {
      get: async (_key: string) => null,
    },
    channelRegistry: {
      get: (_name: string) => undefined,
    },
    dataDir: '/tmp/test',
  };
}

const fakeFactory: ChannelAdapterFactory = {
  id: 'fake',
  label: 'Fake',
  credentialKeys: { token: (name) => `channel:${name}:token` },
  async create(ctx) {
    return new FakeAdapter(`fake:${ctx.channelName}`);
  },
  matchRotatedCredential(key) {
    return key.match(/^channel:(.+):fake-token$/)?.[1];
  },
};

const otherFactory: ChannelAdapterFactory = {
  id: 'other',
  label: 'Other',
  credentialKeys: {},
  async create(ctx) {
    return new FakeAdapter(`other:${ctx.channelName}`);
  },
};

describe('ChannelAdapterRegistry', () => {
  it('registers and looks up a factory by id', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register(fakeFactory);
    expect(registry.has('fake')).toBe(true);
    expect(registry.get('fake')).toBe(fakeFactory);
  });

  it('returns undefined for unknown ids', () => {
    const registry = new ChannelAdapterRegistry();
    expect(registry.get('telegram')).toBeUndefined();
    expect(registry.has('telegram')).toBe(false);
  });

  it('rejects duplicate registration of the same id', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register(fakeFactory);
    expect(() => registry.register(fakeFactory)).toThrow(/already registered/);
  });

  it('preserves registration order in list()', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register(fakeFactory);
    registry.register(otherFactory);
    expect(registry.list().map((f) => f.id)).toEqual(['fake', 'other']);
  });

  it('factory.create() builds an adapter from the context', async () => {
    const registry = new ChannelAdapterRegistry();
    registry.register(fakeFactory);
    const factory = registry.get('fake');
    expect(factory).toBeDefined();
    const adapter = await factory?.create(makeContext('a-channel'));
    expect(adapter?.name).toBe('fake:a-channel');
  });

  it('matchRotatedCredential() returns the matching factory and channel', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register(otherFactory);
    registry.register(fakeFactory);
    expect(registry.matchRotatedCredential('channel:foo:fake-token')).toEqual({
      factoryId: 'fake',
      channelName: 'foo',
    });
  });

  it('matchRotatedCredential() returns undefined when no factory claims the key', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register(fakeFactory);
    expect(registry.matchRotatedCredential('credentials:other:key')).toBeUndefined();
  });

  it('matchRotatedCredential() skips factories without the hook', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register(otherFactory); // no hook
    expect(registry.matchRotatedCredential('channel:any:any')).toBeUndefined();
  });

  it('ChannelCredentialMissingError carries the key', () => {
    const err = new ChannelCredentialMissingError('channel:foo:token');
    expect(err.credentialKey).toBe('channel:foo:token');
    expect(err.message).toContain('channel:foo:token');
    expect(err.name).toBe('ChannelCredentialMissingError');
  });
});

describe('createDefaultChannelAdapterRegistry', () => {
  it('registers the built-in telegram and whatsapp factories', () => {
    const registry = createDefaultChannelAdapterRegistry();
    expect(registry.has('telegram')).toBe(true);
    expect(registry.has('whatsapp')).toBe(true);
    expect(
      registry
        .list()
        .map((f) => f.id)
        .sort(),
    ).toEqual(['telegram', 'whatsapp']);
  });

  it('telegram factory matches the channel:<name>:token credential pattern', () => {
    const registry = createDefaultChannelAdapterRegistry();
    expect(registry.matchRotatedCredential('channel:my-bot:token')).toEqual({
      factoryId: 'telegram',
      channelName: 'my-bot',
    });
    expect(registry.matchRotatedCredential('channel:my-bot:whatsapp-auth')).toBeUndefined();
  });

  it('telegram factory.create() throws ChannelCredentialMissingError when the token is absent', async () => {
    const registry = createDefaultChannelAdapterRegistry();
    const factory = registry.get('telegram');
    expect(factory).toBeDefined();
    await expect(
      factory?.create({
        channelName: 'my-bot',
        credentialStore: { get: async () => null },
        channelRegistry: { get: () => undefined },
        dataDir: '/tmp/test',
      }),
    ).rejects.toBeInstanceOf(ChannelCredentialMissingError);
  });
});
