import { resolve } from 'node:path';

/**
 * Per-agent memory directory: `<dataDir>/memory/<agentId>`. Keyed by the
 * registry id (immutable, what the API addresses) — unlike skills/sessions,
 * which are keyed by `config.name`.
 */
export function agentMemoryDir(dataDir: string, agentId: string): string {
  return resolve(dataDir, 'memory', agentId);
}
