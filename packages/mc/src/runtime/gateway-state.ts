import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Non-secret metadata about the running gateway process.
 *
 * Token secrets (management token + chat token) live in the OS keychain
 * via `KeychainStore` in `../security/keychain-store.ts`. This interface
 * is purely identity + network metadata and is safe to persist to disk
 * in plain JSON.
 */
export interface GatewayState {
  pid: number;
  startedAt: string;
  port: number;
  channelPort: number;
}

export class GatewayStateStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'gateway-state.json');
  }

  async read(): Promise<GatewayState | null> {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const { pid, startedAt, port, channelPort } = parsed as Record<string, unknown>;
      if (
        typeof pid !== 'number' ||
        typeof startedAt !== 'string' ||
        typeof port !== 'number' ||
        typeof channelPort !== 'number'
      ) {
        return null;
      }
      return { pid, startedAt, port, channelPort };
    } catch {
      return null;
    }
  }

  async write(state: GatewayState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // Explicit destructure so `write` is the one place that decides
    // what lands on disk. Any caller passing extra fields has them
    // stripped here.
    const toWrite: GatewayState = {
      pid: state.pid,
      startedAt: state.startedAt,
      port: state.port,
      channelPort: state.channelPort,
    };
    await writeFile(this.filePath, JSON.stringify(toWrite, null, 2));
  }

  async clear(): Promise<void> {
    if (existsSync(this.filePath)) await unlink(this.filePath);
  }
}
