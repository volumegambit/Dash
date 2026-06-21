import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@dash/mcp';
import { McpConfigStore } from './mcp-store.js';
import { registerPluginMcpServers } from './plugin-mcp.js';

function fakes() {
  const added: string[] = [];
  return {
    added,
    mgr: {
      addServer: async (c: McpServerConfig) => {
        if (c.name === 'p-boom') throw new Error('boom');
        added.push(c.name);
      },
    },
    logger: { info() {}, warn() {} },
  };
}

describe('registerPluginMcpServers', () => {
  it('registers each config with the running manager', async () => {
    const f = fakes();
    await registerPluginMcpServers(
      f.mgr,
      [
        {
          pluginName: 'p',
          config: { name: 'p-db', transport: { type: 'stdio', command: 'node' } },
        },
      ],
      f.logger,
    );
    expect(f.added).toEqual(['p-db']);
  });

  it('isolates a failing registration and continues', async () => {
    const f = fakes();
    await registerPluginMcpServers(
      f.mgr,
      [
        { pluginName: 'p', config: { name: 'p-boom', transport: { type: 'stdio', command: 'x' } } },
        { pluginName: 'p', config: { name: 'p-ok', transport: { type: 'stdio', command: 'y' } } },
      ],
      f.logger,
    );
    expect(f.added).toEqual(['p-ok']);
  });

  // Regression: a once-trusted plugin's MCP server must not survive an untrusted
  // reboot. The leak vector is persistence — `GET /runtime/mcp/servers` lists from
  // `configStore.loadConfigs()` and the gateway reconnects every persisted server
  // at boot, both BEFORE the trust gate runs. So the invariant is structural:
  // registering a plugin MCP server must touch only the in-memory manager and
  // never write to the persistent store.
  it('registers plugin MCP servers in-memory only, never persisting them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'gw-plugin-mcp-'));
    try {
      const store = new McpConfigStore(join(dataDir, 'mcp'));
      const added: string[] = [];
      const mgr = {
        addServer: async (c: McpServerConfig) => {
          added.push(c.name);
        },
      };
      const logger = { info() {}, warn() {} };

      await registerPluginMcpServers(
        mgr,
        [
          {
            pluginName: 'p',
            config: { name: 'p-db', transport: { type: 'stdio', command: 'node' } },
          },
        ],
        logger,
      );

      // In-memory registration happened (the server is live this boot)...
      expect(added).toEqual(['p-db']);
      // ...but nothing was persisted, so the next boot — which seeds the manager
      // and the listing solely from loadConfigs() plus the trust-gated loader —
      // cannot resurrect it once the plugin is no longer trusted.
      expect(await store.loadConfigs()).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
