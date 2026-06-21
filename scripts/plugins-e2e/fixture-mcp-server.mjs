// Minimal, self-contained stdio MCP server used by the plugin E2E smoke
// (scripts/plugins-e2e/run.mjs). Exposes a single deterministic `echo` tool so
// the test can prove a plugin's .mcp.json server is registered, connected, and
// callable by an agent — without depending on any external/desktop MCP server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture-mcp', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echo back the provided text. E2E fixture tool.',
    inputSchema: { text: z.string().describe('the text to echo back') },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

await server.connect(new StdioServerTransport());
