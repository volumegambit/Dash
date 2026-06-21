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
    const env = toEnv(s, key);
    out.push({ name, transport: toTransport(s, key), ...(env ? { env } : {}) });
  }
  return out;
}

function toTransport(s: Record<string, unknown>, key: string): TransportConfig {
  const type = typeof s.type === 'string' ? s.type : 'stdio';
  if (type === 'stdio') {
    if (typeof s.command !== 'string' || s.command.length === 0) {
      throw new Error(`mcp server '${key}': stdio transport requires a 'command' string`);
    }
    const args = toArgs(s, key);
    return {
      type: 'stdio',
      command: s.command,
      ...(args ? { args } : {}),
    };
  }
  if (type === 'http' || type === 'streamable-http') {
    requireUrl(s, key);
    const headers = toHeaders(s, key);
    return {
      type: 'streamable-http',
      url: s.url as string,
      ...(headers ? { headers } : {}),
    };
  }
  if (type === 'sse') {
    requireUrl(s, key);
    const headers = toHeaders(s, key);
    return {
      type: 'sse',
      url: s.url as string,
      ...(headers ? { headers } : {}),
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

function toArgs(s: Record<string, unknown>, key: string): string[] | undefined {
  if (s.args === undefined) return undefined;
  if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) {
    throw new Error(`mcp server '${key}': args must be an array of strings`);
  }
  return s.args as string[];
}

function toHeaders(s: Record<string, unknown>, key: string): Record<string, string> | undefined {
  return toStringRecord(s.headers, key, 'headers');
}

function toEnv(s: Record<string, unknown>, key: string): Record<string, string> | undefined {
  return toStringRecord(s.env, key, 'env');
}

function toStringRecord(
  v: unknown,
  key: string,
  field: 'env' | 'headers',
): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isStringRecord(v)) {
    throw new Error(`mcp server '${key}': ${field} values must be strings`);
  }
  return v as Record<string, string>;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((val) => typeof val === 'string')
  );
}
