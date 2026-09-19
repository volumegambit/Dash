import { join } from 'node:path';
import type { ChannelAdapter } from '@dash/channels';
import { vi } from 'vitest';
import { ChannelRegistry } from '../channel-registry.js';
import {
  ChannelAdapterConfigurationError,
  createChannelAdapterFactory,
} from './adapter-factory.js';

describe('channel adapter factory', () => {
  function setup() {
    const channelRegistry = new ChannelRegistry();
    const channel = channelRegistry.register({
      name: 'bot',
      adapter: 'telegram',
      allowedUsers: ['alice'],
      routing: [],
      globalDenyList: [],
    });
    const credentials = new Map<string, string>();
    const adapter = {} as ChannelAdapter;
    const adapters = {
      telegram: vi.fn<(token: string, allowedUsers: () => string[]) => ChannelAdapter>(
        () => adapter,
      ),
      whatsapp: vi.fn<(auth: Record<string, string>, sessionPath: string) => ChannelAdapter>(
        () => adapter,
      ),
    };
    const factory = createChannelAdapterFactory({
      dataDir: '/gateway',
      channelRegistry,
      credentialStore: { get: async (key) => credentials.get(key) ?? null },
      adapters,
    });
    return { channelRegistry, channel, credentials, adapter, adapters, factory };
  }

  it('reads the current token at every construction and resolves allowed users live', async () => {
    const state = setup();
    state.credentials.set('channel:bot:token', 'first-token');
    expect(await state.factory(state.channel, 'create')).toBe(state.adapter);
    expect(state.adapters.telegram).toHaveBeenLastCalledWith('first-token', expect.any(Function));
    const allowedUsers = state.adapters.telegram.mock.calls[0][1];
    expect(allowedUsers()).toEqual(['alice']);
    state.channelRegistry.update('bot', { allowedUsers: ['bob'] });
    expect(allowedUsers()).toEqual(['bob']);
    state.credentials.set('channel:bot:token', 'second-token');
    await state.factory(state.channel, 'restart');
    expect(state.adapters.telegram).toHaveBeenLastCalledWith('second-token', expect.any(Function));
    state.channelRegistry.remove('bot');
    expect(allowedUsers()).toEqual([]);
  });

  it('keeps the legacy WhatsApp create path and requires its auth credential', async () => {
    const state = setup();
    state.channel.adapter = 'whatsapp';
    await expect(state.factory(state.channel, 'create')).rejects.toMatchObject({
      message: "No credential found for key 'channel:bot:whatsapp-auth'",
    });
    state.credentials.set('channel:bot:whatsapp-auth', '{"clientID":"test"}');
    await state.factory(state.channel, 'create');
    expect(state.adapters.whatsapp).toHaveBeenCalledWith({ clientID: 'test' }, 'data/whatsapp/bot');
  });

  it('keeps the startup WhatsApp session path and accepts absent auth', async () => {
    const state = setup();
    state.channel.adapter = 'whatsapp';
    await state.factory(state.channel, 'restore');
    expect(state.adapters.whatsapp).toHaveBeenCalledWith(
      {},
      join('/gateway', 'whatsapp-sessions', 'bot'),
    );
  });

  it('does not disclose malformed credential JSON through parser errors', async () => {
    const state = setup();
    state.channel.adapter = 'whatsapp';
    state.credentials.set('channel:bot:whatsapp-auth', 'private-auth-secret');
    await expect(state.factory(state.channel, 'create')).rejects.toThrow(
      'Invalid WhatsApp credentials',
    );
    try {
      await state.factory(state.channel, 'restore');
    } catch (error) {
      expect(String(error)).not.toContain('private-auth-secret');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('reports missing Telegram tokens and unsupported adapters without starting anything', async () => {
    const state = setup();
    await expect(state.factory(state.channel, 'create')).rejects.toBeInstanceOf(
      ChannelAdapterConfigurationError,
    );
    await expect(
      state.factory({ ...state.channel, adapter: 'unknown' as 'telegram' }, 'create'),
    ).rejects.toThrow('Unknown adapter type: unknown');
    expect(state.adapters.telegram).not.toHaveBeenCalled();
    expect(state.adapters.whatsapp).not.toHaveBeenCalled();
  });
});
