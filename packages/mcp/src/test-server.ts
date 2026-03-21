import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'test-server', version: '1.0.0' });

server.tool(
  'echo',
  'Echoes the input back',
  { input: z.string().describe('Text to echo') },
  async ({ input }) => ({
    content: [{ type: 'text', text: `echo: ${input}` }],
  }),
);

server.tool('fail', 'Always fails', {}, async () => {
  throw new Error('intentional failure');
});

const transport = new StdioServerTransport();
await server.connect(transport);
