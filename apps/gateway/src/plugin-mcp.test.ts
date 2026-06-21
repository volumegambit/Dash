import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@dash/mcp';
import { McpConfigStore } from './mcp-store.js';
import { reconcilePluginMcpServers, registerPluginMcpServers } from './plugin-mcp.js';

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
  it('registers each config with the running manager and returns the registered set', async () => {
    const f = fakes();
    const registered = await registerPluginMcpServers(
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
    // F4: the return set is exactly what actually registered.
    expect([...registered]).toEqual(['p-db']);
  });

  it('isolates a failing registration and excludes it from the returned set (F4)', async () => {
    const f = fakes();
    const registered = await registerPluginMcpServers(
      f.mgr,
      [
        { pluginName: 'p', config: { name: 'p-boom', transport: { type: 'stdio', command: 'x' } } },
        { pluginName: 'p', config: { name: 'p-ok', transport: { type: 'stdio', command: 'y' } } },
      ],
      f.logger,
    );
    expect(f.added).toEqual(['p-ok']);
    // The skipped 'p-boom' (a collision/spawn failure stand-in) is NOT in the
    // returned set, so a later reload won't try to tear it down (F4).
    expect([...registered]).toEqual(['p-ok']);
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

describe('reconcilePluginMcpServers (hot-reload remove-then-add)', () => {
  function reconcileFakes() {
    const removed: string[] = [];
    const added: string[] = [];
    return {
      removed,
      added,
      logger: { info() {}, warn() {} },
      mgr: {
        removeServer: async (name: string) => {
          removed.push(name);
        },
        addServer: async (c: McpServerConfig) => {
          added.push(c.name);
        },
      },
    };
  }

  it('removes the previous server set, then re-registers the new set (remove-first)', async () => {
    const f = reconcileFakes();
    await reconcilePluginMcpServers(
      f.mgr,
      ['p-old', 'p-keep'],
      [
        { pluginName: 'p', config: { name: 'p-keep', transport: { type: 'stdio', command: 'a' } } },
        { pluginName: 'p', config: { name: 'p-new', transport: { type: 'stdio', command: 'b' } } },
      ],
      f.logger,
    );
    // Every previously-registered server is torn down (remove-first so the
    // surviving 'p-keep' can be re-added without an addServer duplicate reject)...
    expect(f.removed).toEqual(['p-old', 'p-keep']);
    // ...then the full new set is additively re-registered.
    expect(f.added).toEqual(['p-keep', 'p-new']);
  });

  it('fail-isolates a failing removal and still re-registers the new set', async () => {
    const f = reconcileFakes();
    const mgr = {
      removeServer: async (name: string) => {
        if (name === 'p-gone') throw new Error('already gone');
        f.removed.push(name);
      },
      addServer: f.mgr.addServer,
    };
    await reconcilePluginMcpServers(
      mgr,
      ['p-gone', 'p-ok'],
      [{ pluginName: 'p', config: { name: 'p-new', transport: { type: 'stdio', command: 'b' } } }],
      f.logger,
    );
    // The throwing removal is swallowed; the rest of the removals proceed...
    expect(f.removed).toEqual(['p-ok']);
    // ...and the re-register pass still runs.
    expect(f.added).toEqual(['p-new']);
  });

  it('removes all old servers when the new wiring declares none', async () => {
    const f = reconcileFakes();
    await reconcilePluginMcpServers(f.mgr, ['p-a', 'p-b'], [], f.logger);
    expect(f.removed).toEqual(['p-a', 'p-b']);
    expect(f.added).toEqual([]);
  });

  it('returns the actually-registered set as the next reload teardown set', async () => {
    const f = reconcileFakes();
    const next = await reconcilePluginMcpServers(
      f.mgr,
      ['p-old'],
      [{ pluginName: 'p', config: { name: 'p-new', transport: { type: 'stdio', command: 'b' } } }],
      f.logger,
    );
    expect([...next]).toEqual(['p-new']);
  });

  // T-d (F4): an OPERATOR server 'x' already exists; a plugin also declares 'x'.
  // At registration the plugin's 'x' collides (addServer rejects) and is skipped,
  // so it is NOT in the registered set. On the NEXT reload, the teardown set is
  // that registered set — so reconcile must NOT removeServer('x'), leaving the
  // operator's server alive.
  it('never tears down an operator-owned server that shares a plugin server name (T-d, F4)', async () => {
    const operatorServers = new Set(['x']); // operator started 'x' from the persistent store
    const removed: string[] = [];
    const mgr = {
      addServer: async (c: McpServerConfig) => {
        // addServer rejects a duplicate name — exactly the boot collision case.
        if (operatorServers.has(c.name)) throw new Error(`server '${c.name}' already exists`);
        operatorServers.add(c.name);
      },
      removeServer: async (name: string) => {
        removed.push(name);
        operatorServers.delete(name);
      },
    };
    const logger = { info() {}, warn() {} };

    // Boot-equivalent: register the plugin's 'x' (collides → skipped) and 'y'.
    const registered = await registerPluginMcpServers(
      mgr,
      [
        { pluginName: 'p', config: { name: 'x', transport: { type: 'stdio', command: 'a' } } },
        { pluginName: 'p', config: { name: 'y', transport: { type: 'stdio', command: 'b' } } },
      ],
      logger,
    );
    // Only 'y' actually registered; 'x' belongs to the operator.
    expect([...registered].sort()).toEqual(['y']);

    // Reload with the plugin now declaring nothing. Teardown set = registered set.
    await reconcilePluginMcpServers(mgr, [...registered], [], logger);

    // The operator's 'x' was NEVER removed; only the gateway-owned 'y' was.
    expect(removed).toEqual(['y']);
    expect(operatorServers.has('x')).toBe(true);
  });
});
