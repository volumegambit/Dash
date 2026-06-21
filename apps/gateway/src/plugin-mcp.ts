import type { McpManager, McpServerConfig } from '@dash/mcp';

interface ConfigStore {
  addConfig(config: McpServerConfig): Promise<void>;
  removeConfig(name: string): Promise<void>;
}
interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Registers translated plugin MCP servers with the running manager + config
 * store. Fail-isolated: a server that throws (bad spawn, dup name) is logged
 * and skipped — it never aborts the others or gateway startup. Servers whose
 * name already exists in the store are skipped (operator/other-plugin owns it).
 */
export async function registerPluginMcpServers(
  mcpManager: Pick<McpManager, 'addServer'>,
  store: ConfigStore,
  configs: Array<{ pluginName: string; config: McpServerConfig }>,
  logger: Logger,
): Promise<void> {
  for (const { pluginName, config } of configs) {
    try {
      await mcpManager.addServer(config);
      await store.addConfig(config);
      logger.info(`[plugins] registered MCP server '${config.name}' (plugin '${pluginName}')`);
    } catch (err) {
      logger.warn(
        `[plugins] MCP server '${config.name}' (plugin '${pluginName}') failed: ${(err as Error).message}`,
      );
    }
  }
}
