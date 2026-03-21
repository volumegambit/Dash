import type { McpServerConfig } from './types.js';

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/** Replace ${VAR} patterns in a string with values from the env map. */
export function interpolateEnvVars(str: string, env: Record<string, string | undefined>): string {
  return str.replace(ENV_VAR_PATTERN, (_, varName) => env[varName] ?? '');
}

/** Deep-walk a config object and interpolate all string values. */
export function interpolateConfigEnvVars(
  config: McpServerConfig,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): McpServerConfig {
  return JSON.parse(JSON.stringify(config), (_key, value) => {
    if (typeof value === 'string') {
      return interpolateEnvVars(value, env);
    }
    return value;
  });
}
