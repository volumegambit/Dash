import {
  type McpServerConfig,
  NAMESPACE_SEPARATOR,
  SERVER_NAME_PATTERN,
  type TransportConfig,
} from '@dash/mcp';

/**
 * Translates a Claude Code `.mcp.json` object (`{ mcpServers: { name: server } }`)
 * into Dash `McpServerConfig[]`. Each server is namespaced `<plugin>-<name>` to
 * avoid cross-plugin collisions, and validated against Dash's MCP name rules.
 * Transport mapping: stdio→stdio, Claude `http`→Dash `streamable-http`, sse→sse.
 * `ws` and unknown types are rejected (Dash has no ws transport). `${VAR}`
 * expansion is intentionally NOT done here (Plan 3 owns path/env substitution).
 */
export function translateMcpJson(raw: unknown, pluginName: string): McpServerConfig[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const servers = (raw as Record<string, unknown>).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return [];

  const out: McpServerConfig[] = [];
  for (const [key, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`mcp server '${key}' must be an object`);
    }
    const s = value as Record<string, unknown>;
    const name = `${pluginName}-${key}`;
    if (name.includes(NAMESPACE_SEPARATOR) || !SERVER_NAME_PATTERN.test(name)) {
      throw new Error(
        `invalid MCP server name '${name}' (from plugin '${pluginName}', key '${key}') — must match ${SERVER_NAME_PATTERN} and not contain '${NAMESPACE_SEPARATOR}'`,
      );
    }
    out.push({ name, transport: toTransport(s, key), ...(toEnv(s) ? { env: toEnv(s) } : {}) });
  }
  return out;
}

function toTransport(s: Record<string, unknown>, key: string): TransportConfig {
  const type = typeof s.type === 'string' ? s.type : 'stdio';
  if (type === 'stdio') {
    if (typeof s.command !== 'string' || s.command.length === 0) {
      throw new Error(`mcp server '${key}': stdio transport requires a 'command' string`);
    }
    return {
      type: 'stdio',
      command: s.command,
      ...(Array.isArray(s.args) ? { args: s.args as string[] } : {}),
    };
  }
  if (type === 'http' || type === 'streamable-http') {
    requireUrl(s, key);
    return {
      type: 'streamable-http',
      url: s.url as string,
      ...(toHeaders(s) ? { headers: toHeaders(s) } : {}),
    };
  }
  if (type === 'sse') {
    requireUrl(s, key);
    return {
      type: 'sse',
      url: s.url as string,
      ...(toHeaders(s) ? { headers: toHeaders(s) } : {}),
    };
  }
  throw new Error(
    `mcp server '${key}': unsupported transport type '${type}' (supported: stdio, http, sse)`,
  );
}

function requireUrl(s: Record<string, unknown>, key: string): void {
  if (typeof s.url !== 'string' || s.url.length === 0) {
    throw new Error(`mcp server '${key}': remote transport requires a 'url' string`);
  }
}

function toHeaders(s: Record<string, unknown>): Record<string, string> | undefined {
  return isStringRecord(s.headers) ? (s.headers as Record<string, string>) : undefined;
}

function toEnv(s: Record<string, unknown>): Record<string, string> | undefined {
  return isStringRecord(s.env) ? (s.env as Record<string, string>) : undefined;
}

function isStringRecord(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
