import type { McpServerConfig } from '@dash/mcp';
import { registerPluginMcpServers } from './plugin-mcp.js';

function fakes() {
  const added: string[] = [];
  const stored: string[] = [];
  return {
    added,
    stored,
    mgr: {
      addServer: async (c: McpServerConfig) => {
        if (c.name === 'p-boom') throw new Error('boom');
        added.push(c.name);
      },
    },
    store: {
      addConfig: async (c: McpServerConfig) => {
        stored.push(c.name);
      },
      removeConfig: async () => {},
    },
    logger: { info() {}, warn() {} },
  };
}

describe('registerPluginMcpServers', () => {
  it('registers each config and persists it', async () => {
    const f = fakes();
    await registerPluginMcpServers(
      f.mgr,
      f.store,
      [
        {
          pluginName: 'p',
          config: { name: 'p-db', transport: { type: 'stdio', command: 'node' } },
        },
      ],
      f.logger,
    );
    expect(f.added).toEqual(['p-db']);
    expect(f.stored).toEqual(['p-db']);
  });

  it('isolates a failing registration and continues', async () => {
    const f = fakes();
    await registerPluginMcpServers(
      f.mgr,
      f.store,
      [
        { pluginName: 'p', config: { name: 'p-boom', transport: { type: 'stdio', command: 'x' } } },
        { pluginName: 'p', config: { name: 'p-ok', transport: { type: 'stdio', command: 'y' } } },
      ],
      f.logger,
    );
    expect(f.added).toEqual(['p-ok']);
  });
});
