import type { McpManager, McpServerConfig } from '@dash/mcp';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Registers translated plugin MCP servers with the running manager — IN MEMORY
 * ONLY, never persisted to the config store. This is deliberate and load-bearing:
 * persisted MCP servers are reconnected at every boot and surfaced by
 * `GET /runtime/mcp/servers` straight from `configStore.loadConfigs()`, both
 * BEFORE the plugin trust gate runs. Persisting a plugin's server would let it
 * outlive the plugin's `trusted` flag — drop trust / disable / remove the plugin
 * and reboot, and a persisted entry would still reconnect and serve its tools.
 *
 * By registering only in-memory each boot, purely from the already trust-gated
 * `loadedPlugins.mcpConfigs`, a plugin MCP server's lifecycle tracks plugin trust
 * automatically: no trust, no entry in `mcpConfigs`, nothing registered.
 *
 * Fail-isolated: a server that throws (bad spawn, or a name collision with an
 * operator server already started from the persistent store — `addServer` rejects
 * duplicate names) is logged and skipped; it never aborts the others or startup.
 */
export async function registerPluginMcpServers(
  mcpManager: Pick<McpManager, 'addServer'>,
  configs: Array<{ pluginName: string; config: McpServerConfig }>,
  logger: Logger,
): Promise<void> {
  for (const { pluginName, config } of configs) {
    try {
      await mcpManager.addServer(config);
      logger.info(`[plugins] registered MCP server '${config.name}' (plugin '${pluginName}')`);
    } catch (err) {
      logger.warn(
        `[plugins] MCP server '${config.name}' (plugin '${pluginName}') failed: ${(err as Error).message}`,
      );
    }
  }
}
