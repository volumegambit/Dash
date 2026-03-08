import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagingApp } from '../types.js';
import { MessagingAppRegistry } from './registry.js';

const testApp: MessagingApp = {
  id: 'app-1',
  name: 'My Telegram Bot',
  type: 'telegram',
  credentialsKey: 'messaging-app:app-1:token',
  enabled: true,
  createdAt: '2026-03-08T00:00:00Z',
  globalDenyList: [],
  routing: [
    {
      id: 'rule-1',
      condition: { type: 'default' },
      targetAgentName: 'default',
      allowList: [],
      denyList: [],
    },
  ],
};

describe('MessagingAppRegistry', () => {
  let tempDir: string;
  let registry: MessagingAppRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mc-messaging-apps-'));
    registry = new MessagingAppRegistry(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('lists empty when no apps exist', async () => {
    expect(await registry.list()).toEqual([]);
  });

  it('adds and retrieves an app', async () => {
    await registry.add(testApp);
    expect(await registry.get('app-1')).toEqual(testApp);
  });

  it('lists all apps', async () => {
    await registry.add(testApp);
    await registry.add({ ...testApp, id: 'app-2', name: 'Second Bot' });
    expect(await registry.list()).toHaveLength(2);
  });

  it('throws when adding a duplicate id', async () => {
    await registry.add(testApp);
    await expect(registry.add(testApp)).rejects.toThrow('already exists');
  });

  it('updates an app', async () => {
    await registry.add(testApp);
    await registry.update('app-1', { enabled: false });
    expect((await registry.get('app-1'))?.enabled).toBe(false);
  });

  it('throws when updating non-existent app', async () => {
    await expect(registry.update('missing', { enabled: false })).rejects.toThrow('not found');
  });

  it('removes an app', async () => {
    await registry.add(testApp);
    await registry.remove('app-1');
    expect(await registry.get('app-1')).toBeNull();
  });

  it('throws when removing non-existent app', async () => {
    await expect(registry.remove('missing')).rejects.toThrow('not found');
  });

  it('persists across instances', async () => {
    await registry.add(testApp);
    const newRegistry = new MessagingAppRegistry(tempDir);
    expect(await newRegistry.get('app-1')).toEqual(testApp);
  });

  it('returns null for non-existent id', async () => {
    expect(await registry.get('non-existent')).toBeNull();
  });
});
