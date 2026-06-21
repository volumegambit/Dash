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

/**
 * Hot-reload the live set of plugin MCP servers: remove the previously-registered
 * set, then additively re-register the new set. Used by the gateway's
 * `onWiringRebuilt` callback when a plugin reload changes which MCP servers are
 * trusted/declared.
 *
 * Remove-FIRST is required, not cosmetic: `addServer` rejects duplicate names, so
 * a server whose name survives across the reload (most of them) must be torn down
 * before it can be re-added against the new wiring. `oldServerNames` is the set we
 * registered last time — captured by the caller BEFORE it swaps its live wiring
 * reference, so we remove exactly what we added (the new wiring may add, drop, or
 * rename servers).
 *
 * Each removal is fail-isolated: a server already gone (or mid-teardown) is logged
 * and skipped so it never aborts the remaining removals or the re-register pass.
 * The additive re-register delegates to `registerPluginMcpServers`, which is itself
 * fail-isolated per server.
 */
export async function reconcilePluginMcpServers(
  mcpManager: Pick<McpManager, 'addServer' | 'removeServer'>,
  oldServerNames: string[],
  newConfigs: Array<{ pluginName: string; config: McpServerConfig }>,
  logger: Logger,
): Promise<void> {
  for (const name of oldServerNames) {
    try {
      await mcpManager.removeServer(name);
    } catch (err) {
      logger.warn(
        `[plugins] reload: removing MCP server '${name}' failed: ${(err as Error).message}`,
      );
    }
  }
  await registerPluginMcpServers(mcpManager, newConfigs, logger);
}
