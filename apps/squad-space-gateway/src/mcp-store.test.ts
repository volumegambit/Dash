import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@dash/mcp';
import { McpConfigStore } from './mcp-store.js';

describe('McpConfigStore', () => {
  let dir: string;
  let store: McpConfigStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-store-'));
    store = new McpConfigStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sampleConfig: McpServerConfig = {
    name: 'test-server',
    transport: { type: 'stdio', command: 'echo', args: ['hello'] },
  };

  describe('configs', () => {
    it('returns empty array when no configs exist', async () => {
      expect(await store.loadConfigs()).toEqual([]);
    });

    it('adds and loads a config', async () => {
      await store.addConfig(sampleConfig);
      const configs = await store.loadConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('test-server');
    });

    it('removes a config by name', async () => {
      await store.addConfig(sampleConfig);
      await store.removeConfig('test-server');
      expect(await store.loadConfigs()).toEqual([]);
    });

    it('throws when adding duplicate name', async () => {
      await store.addConfig(sampleConfig);
      await expect(store.addConfig(sampleConfig)).rejects.toThrow('already exists');
    });

    it('persists to disk and survives new instance', async () => {
      await store.addConfig(sampleConfig);
      const store2 = new McpConfigStore(dir);
      const configs = await store2.loadConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('test-server');
    });

    it('writes file with 0600 permissions', async () => {
      await store.addConfig(sampleConfig);
      const s = await stat(join(dir, 'configs.json'));
      expect(s.mode & 0o777).toBe(0o600);
    });
  });

  describe('allowlist', () => {
    it('returns empty array when no allowlist exists', async () => {
      expect(await store.loadAllowlist()).toEqual([]);
    });

    it('saves and loads allowlist', async () => {
      await store.saveAllowlist(['https://example.com/*', 'https://trusted.io/*']);
      const list = await store.loadAllowlist();
      expect(list).toEqual(['https://example.com/*', 'https://trusted.io/*']);
    });

    it('replaces entire allowlist on save', async () => {
      await store.saveAllowlist(['https://a.com']);
      await store.saveAllowlist(['https://b.com']);
      expect(await store.loadAllowlist()).toEqual(['https://b.com']);
    });

    it('persists to disk', async () => {
      await store.saveAllowlist(['https://example.com']);
      const store2 = new McpConfigStore(dir);
      expect(await store2.loadAllowlist()).toEqual(['https://example.com']);
    });
  });

  describe('isAllowed', () => {
    it('allows everything when allowlist is empty', async () => {
      expect(await store.isAllowed('https://anything.com')).toBe(true);
    });

    it('allows matching URLs', async () => {
      await store.saveAllowlist(['https://example.com']);
      expect(await store.isAllowed('https://example.com')).toBe(true);
    });

    it('rejects non-matching URLs', async () => {
      await store.saveAllowlist(['https://example.com']);
      expect(await store.isAllowed('https://evil.com')).toBe(false);
    });

    it('supports wildcard patterns', async () => {
      await store.saveAllowlist(['https://*.example.com']);
      expect(await store.isAllowed('https://mcp.example.com')).toBe(true);
      expect(await store.isAllowed('https://evil.com')).toBe(false);
    });
  });
});
