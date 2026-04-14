import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelRegistry } from './channel-registry.js';
import type { ChannelConfig } from './channel-registry.js';

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: 'test-channel',
    adapter: 'telegram',
    globalDenyList: [],
    routing: [
      {
        condition: { type: 'default' },
        agentId: 'agent-1',
        allowList: [],
        denyList: [],
      },
    ],
    ...overrides,
  };
}

describe('ChannelRegistry', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'channel-registry-test-'));
    filePath = join(tmpDir, 'channels.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('registers a channel', () => {
    const registry = new ChannelRegistry();
    const channel = registry.register(makeConfig());
    expect(channel.name).toBe('test-channel');
    expect(channel.adapter).toBe('telegram');
    expect(channel.registeredAt).toBeDefined();
  });

  it('get returns registered channel', () => {
    const registry = new ChannelRegistry();
    registry.register(makeConfig({ name: 'my-channel' }));
    const found = registry.get('my-channel');
    expect(found).toBeDefined();
    expect(found?.name).toBe('my-channel');
  });

  it('get returns undefined for unknown channel', () => {
    const registry = new ChannelRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('list returns all channels', () => {
    const registry = new ChannelRegistry();
    registry.register(makeConfig({ name: 'channel-a' }));
    registry.register(makeConfig({ name: 'channel-b' }));
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name)).toContain('channel-a');
    expect(all.map((c) => c.name)).toContain('channel-b');
  });

  it('update replaces config fields', () => {
    const registry = new ChannelRegistry();
    registry.register(makeConfig({ name: 'ch', globalDenyList: ['user-1'] }));
    const updated = registry.update('ch', { globalDenyList: ['user-2', 'user-3'] });
    expect(updated.globalDenyList).toEqual(['user-2', 'user-3']);
  });

  it('update throws if channel not found', () => {
    const registry = new ChannelRegistry();
    expect(() => registry.update('missing', { adapter: 'whatsapp' })).toThrow(
      "Channel 'missing' not found",
    );
  });

  it('remove deletes channel', () => {
    const registry = new ChannelRegistry();
    registry.register(makeConfig({ name: 'to-remove' }));
    expect(registry.has('to-remove')).toBe(true);
    const result = registry.remove('to-remove');
    expect(result).toBe(true);
    expect(registry.has('to-remove')).toBe(false);
  });

  it('remove returns false for unknown channel', () => {
    const registry = new ChannelRegistry();
    expect(registry.remove('ghost')).toBe(false);
  });

  it('removeRoutesForAgent cleans up rules but keeps channel if rules remain', () => {
    const registry = new ChannelRegistry();
    registry.register(
      makeConfig({
        name: 'mixed-channel',
        routing: [
          { condition: { type: 'default' }, agentId: 'agent-1', allowList: [], denyList: [] },
          {
            condition: { type: 'sender', ids: ['u1'] },
            agentId: 'agent-2',
            allowList: [],
            denyList: [],
          },
        ],
      }),
    );
    const removed = registry.removeRoutesForAgent('agent-1');
    expect(removed).toEqual([]);
    const channel = registry.get('mixed-channel');
    expect(channel).toBeDefined();
    expect(channel?.routing).toHaveLength(1);
    expect(channel?.routing[0].agentId).toBe('agent-2');
  });

  it('removeRoutesForAgent removes channel if no rules remain and returns channel name', () => {
    const registry = new ChannelRegistry();
    registry.register(
      makeConfig({
        name: 'solo-channel',
        routing: [
          { condition: { type: 'default' }, agentId: 'agent-x', allowList: [], denyList: [] },
        ],
      }),
    );
    const removed = registry.removeRoutesForAgent('agent-x');
    expect(removed).toEqual(['solo-channel']);
    expect(registry.has('solo-channel')).toBe(false);
  });

  it('removeRoutesForAgent handles multiple channels some fully removed', () => {
    const registry = new ChannelRegistry();
    registry.register(
      makeConfig({
        name: 'ch-1',
        routing: [
          { condition: { type: 'default' }, agentId: 'agent-z', allowList: [], denyList: [] },
        ],
      }),
    );
    registry.register(
      makeConfig({
        name: 'ch-2',
        routing: [
          { condition: { type: 'default' }, agentId: 'agent-z', allowList: [], denyList: [] },
          {
            condition: { type: 'group', ids: ['g1'] },
            agentId: 'agent-y',
            allowList: [],
            denyList: [],
          },
        ],
      }),
    );
    const removed = registry.removeRoutesForAgent('agent-z');
    expect(removed).toEqual(['ch-1']);
    expect(registry.has('ch-1')).toBe(false);
    expect(registry.has('ch-2')).toBe(true);
    expect(registry.get('ch-2')?.routing).toHaveLength(1);
  });

  it('persists and reloads channels', async () => {
    const registry = new ChannelRegistry(filePath);
    registry.register(
      makeConfig({ name: 'persist-me', adapter: 'whatsapp', globalDenyList: ['blocked'] }),
    );
    await registry.save();

    const registry2 = new ChannelRegistry(filePath);
    await registry2.load();
    const channel = registry2.get('persist-me');
    expect(channel).toBeDefined();
    expect(channel?.adapter).toBe('whatsapp');
    expect(channel?.globalDenyList).toEqual(['blocked']);
    expect(channel?.registeredAt).toBeDefined();
  });

  it('load is no-op when file does not exist', async () => {
    const registry = new ChannelRegistry(join(tmpDir, 'nonexistent.json'));
    await expect(registry.load()).resolves.toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it('save is no-op when no filePath', async () => {
    const registry = new ChannelRegistry();
    registry.register(makeConfig());
    await expect(registry.save()).resolves.toBeUndefined();
  });

  it('has returns correct boolean', () => {
    const registry = new ChannelRegistry();
    registry.register(makeConfig({ name: 'exists' }));
    expect(registry.has('exists')).toBe(true);
    expect(registry.has('missing')).toBe(false);
  });

  it('register defaults allowedUsers to empty array when omitted', () => {
    const registry = new ChannelRegistry();
    const channel = registry.register(makeConfig({ name: 'no-allow' }));
    expect(channel.allowedUsers).toEqual([]);
  });

  it('update patches allowedUsers', () => {
    const registry = new ChannelRegistry();
    registry.register(makeConfig({ name: 'ch', allowedUsers: ['@alice'] }));
    const updated = registry.update('ch', { allowedUsers: ['@alice', '@bob'] });
    expect(updated.allowedUsers).toEqual(['@alice', '@bob']);
  });

  it('persists and reloads allowedUsers', async () => {
    const registry = new ChannelRegistry(filePath);
    registry.register(makeConfig({ name: 'allow-persist', allowedUsers: ['@alice', '12345'] }));
    await registry.save();

    const registry2 = new ChannelRegistry(filePath);
    await registry2.load();
    const channel = registry2.get('allow-persist');
    expect(channel?.allowedUsers).toEqual(['@alice', '12345']);
  });

  it('load normalizes missing allowedUsers from legacy channels.json to []', async () => {
    // Write a file that pre-dates the allowedUsers field.
    const legacy = [
      {
        name: 'legacy',
        adapter: 'telegram' as const,
        globalDenyList: [],
        routing: [
          { condition: { type: 'default' }, agentId: 'agent-1', allowList: [], denyList: [] },
        ],
        registeredAt: new Date().toISOString(),
        // note: no `allowedUsers` field
      },
    ];
    await writeFile(filePath, JSON.stringify(legacy));

    const registry = new ChannelRegistry(filePath);
    await registry.load();
    const channel = registry.get('legacy');
    expect(channel).toBeDefined();
    expect(channel?.allowedUsers).toEqual([]);
  });
});
