import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '@dash/mcp';
import type { McpServerConfig } from '@dash/mcp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testServerPath = resolve(__dirname, '../../../mcp/src/test-server.ts');

describe('PiAgentBackend MCP integration', () => {
  it('McpManager discovers tools from test server', async () => {
    const config: McpServerConfig = {
      name: 'test',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', testServerPath],
      },
      toolTimeout: 10_000,
    };

    const manager = new McpManager([config]);
    await manager.start();

    const tools = manager.getTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.name === 'test__echo')).toBe(true);

    const echoTool = tools.find((t) => t.name === 'test__echo')!;
    const result = await echoTool.execute('call-1', { input: 'integration-test' });
    const text = result.content.find((c: any) => c.type === 'text') as { text: string };
    expect(text.text).toContain('integration-test');

    await manager.stop();
  }, 15_000);
});
