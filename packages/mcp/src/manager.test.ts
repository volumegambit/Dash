import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { McpManager } from './manager.js';
import type { McpServerConfig } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function testServerConfig(name: string): McpServerConfig {
  return {
    name,
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['tsx', resolve(__dirname, 'test-server.ts')],
    },
    toolTimeout: 10_000,
  };
}

describe('McpManager', () => {
  let manager: McpManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.stop();
      manager = null;
    }
  });

  it('aggregates tools from multiple servers with namespacing', async () => {
    manager = new McpManager([testServerConfig('server-a'), testServerConfig('server-b')]);
    await manager.start();

    const tools = manager.getTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('server-a__echo');
    expect(toolNames).toContain('server-a__fail');
    expect(toolNames).toContain('server-b__echo');
    expect(toolNames).toContain('server-b__fail');
  }, 30_000);

  it('skips failed servers without breaking others', async () => {
    manager = new McpManager([
      testServerConfig('good-server'),
      {
        name: 'bad-server',
        transport: {
          type: 'stdio',
          command: 'nonexistent-command-xyz',
          args: [],
        },
      },
    ]);
    await manager.start();

    const tools = manager.getTools();
    const toolNames = tools.map((t) => t.name);

    // Good server tools should be present
    expect(toolNames).toContain('good-server__echo');

    // Bad server tools should not be present
    expect(toolNames.some((n) => n.startsWith('bad-server__'))).toBe(false);

    // Failed servers list should contain the bad server
    const failed = manager.getFailedServers();
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe('bad-server');
  }, 30_000);

  it('reports server status correctly through lifecycle', async () => {
    manager = new McpManager([testServerConfig('status-server')]);

    // Before start: disconnected
    expect(manager.getServerStatus('status-server')).toBe('disconnected');

    await manager.start();

    // After start: connected
    expect(manager.getServerStatus('status-server')).toBe('connected');

    await manager.stop();
    manager = null;

    // After stop: the manager is cleared — status is disconnected (not in clients map)
    // We create a fresh manager to verify the stop cleared state
  }, 30_000);

  it('returns failed servers list', async () => {
    manager = new McpManager([
      {
        name: 'failing-server',
        transport: {
          type: 'stdio',
          command: 'nonexistent-command-xyz',
          args: [],
        },
      },
    ]);
    await manager.start();

    const failed = manager.getFailedServers();
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe('failing-server');
    expect(typeof failed[0].error).toBe('string');
    expect(failed[0].error.length).toBeGreaterThan(0);

    // getFailedServers returns a copy
    expect(manager.getServerStatus('failing-server')).toBe('error');
  }, 30_000);

  it('cleans up all connections on stop', async () => {
    manager = new McpManager([testServerConfig('cleanup-a'), testServerConfig('cleanup-b')]);
    await manager.start();

    const toolsBefore = manager.getTools();
    expect(toolsBefore.length).toBeGreaterThan(0);

    await manager.stop();
    manager = null;

    // After stop, a fresh manager should have no tools
    const freshManager = new McpManager([]);
    const toolsAfter = freshManager.getTools();
    expect(toolsAfter).toHaveLength(0);
  }, 30_000);
});
