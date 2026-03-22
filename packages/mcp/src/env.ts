import type { McpLogger, McpServerConfig } from './types.js';

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/** Replace ${VAR} patterns in a string with values from the env map. */
export function interpolateEnvVars(
  str: string,
  env: Record<string, string | undefined>,
  logger?: McpLogger,
): string {
  return str.replace(ENV_VAR_PATTERN, (_, varName) => {
    const value = env[varName];
    if (value === undefined) {
      logger?.warn(`Unresolved env var "\${${varName}}" — replaced with empty string`);
      return '';
    }
    return value;
  });
}

/** Deep-walk a config object and interpolate all string values using config.env. */
export function interpolateConfigEnvVars(
  config: McpServerConfig,
  logger?: McpLogger,
): McpServerConfig {
  const env = config.env ?? {};
  return JSON.parse(JSON.stringify(config), (_key, value) => {
    if (typeof value === 'string') {
      return interpolateEnvVars(value, env, logger);
    }
    return value;
  });
}
