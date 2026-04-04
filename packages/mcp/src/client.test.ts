import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from './client.js';
import type { McpServerConfig } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function testServerConfig(name = 'test'): McpServerConfig {
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

describe('McpClient', () => {
  let client: McpClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.stop();
      client = null;
    }
  });

  it('connects to stdio server and discovers tools', async () => {
    client = new McpClient(testServerConfig());
    await client.start();

    const tools = client.getTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('test__echo');
    expect(toolNames).toContain('test__fail');
  }, 15_000);

  it('executes a tool and returns result', async () => {
    client = new McpClient(testServerConfig());
    await client.start();

    const tools = client.getTools();
    const echoTool = tools.find((t) => t.name === 'test__echo');
    if (!echoTool) throw new Error('echo tool not found');

    const result = await echoTool.execute('call-1', { input: 'hello world' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('echo: hello world');
  }, 15_000);

  it('handles tool execution errors gracefully', async () => {
    client = new McpClient(testServerConfig());
    await client.start();

    const tools = client.getTools();
    const failTool = tools.find((t) => t.name === 'test__fail');
    if (!failTool) throw new Error('fail tool not found');

    const result = await failTool.execute('call-2', {});
    // Either isError flag or error text in content
    const hasError =
      result.details?.isError === true ||
      result.content.some((c) => c.text?.toLowerCase().includes('error'));
    expect(hasError).toBe(true);
  }, 15_000);

  it('reports status as connected after start', async () => {
    client = new McpClient(testServerConfig());
    expect(client.status).toBe('disconnected');

    await client.start();
    expect(client.status).toBe('connected');
  }, 15_000);

  it('reports status as disconnected after stop', async () => {
    client = new McpClient(testServerConfig());
    await client.start();
    expect(client.status).toBe('connected');

    await client.stop();
    expect(client.status).toBe('disconnected');
    client = null; // already stopped, prevent afterEach from calling again
  }, 15_000);

  it('accepts onStatusChange callback without error', () => {
    const onChange = vi.fn();
    client = new McpClient(testServerConfig(), { onStatusChange: onChange });
    expect(client.status).toBe('disconnected');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onStatusChange when status changes', async () => {
    const onChange = vi.fn();
    client = new McpClient(testServerConfig(), { onStatusChange: onChange });
    await client.start();
    expect(onChange).toHaveBeenCalledWith('test', 'connected');
  }, 15_000);

  it('reauthorize() throws if not in needs_reauth state', async () => {
    client = new McpClient(testServerConfig());
    await expect(client.reauthorize()).rejects.toThrow('Cannot reauthorize');
  });
});
