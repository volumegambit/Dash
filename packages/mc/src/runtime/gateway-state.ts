import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface GatewayState {
  pid: number;
  startedAt: string;
  token: string;
  port: number;
  channelPort: number;
  chatToken?: string;
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
      return JSON.parse(raw) as GatewayState;
    } catch {
      return null;
    }
  }

  async write(state: GatewayState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }

  async clear(): Promise<void> {
    if (existsSync(this.filePath)) await unlink(this.filePath);
  }
}
