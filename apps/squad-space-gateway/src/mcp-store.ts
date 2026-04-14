import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpConfigStoreInterface, McpServerConfig } from '@dash/mcp';

/**
 * Persists MCP server configs and allowlist to the gateway's data directory.
 * All files are written with 0600 permissions using atomic writes.
 */
export class McpConfigStore implements McpConfigStoreInterface {
  private readonly configsPath: string;
  private readonly allowlistPath: string;

  constructor(private readonly mcpDir: string) {
    this.configsPath = join(mcpDir, 'configs.json');
    this.allowlistPath = join(mcpDir, 'allowlist.json');
  }

  async loadConfigs(): Promise<McpServerConfig[]> {
    try {
      const raw = await readFile(this.configsPath, 'utf-8');
      return JSON.parse(raw) as McpServerConfig[];
    } catch {
      return [];
    }
  }

  async saveConfigs(configs: McpServerConfig[]): Promise<void> {
    await this.atomicWrite(this.configsPath, JSON.stringify(configs, null, 2));
  }

  async addConfig(config: McpServerConfig): Promise<void> {
    const configs = await this.loadConfigs();
    if (configs.some((c) => c.name === config.name)) {
      throw new Error(`MCP server "${config.name}" already exists`);
    }
    configs.push(config);
    await this.saveConfigs(configs);
  }

  async removeConfig(name: string): Promise<void> {
    const configs = await this.loadConfigs();
    const filtered = configs.filter((c) => c.name !== name);
    await this.saveConfigs(filtered);
  }

  async loadAllowlist(): Promise<string[]> {
    try {
      const raw = await readFile(this.allowlistPath, 'utf-8');
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async saveAllowlist(patterns: string[]): Promise<void> {
    await this.atomicWrite(this.allowlistPath, JSON.stringify(patterns, null, 2));
  }

  /**
   * Check if a URL is allowed by the current allowlist.
   * Empty allowlist means everything is allowed.
   */
  async isAllowed(url: string): Promise<boolean> {
    const patterns = await this.loadAllowlist();
    if (patterns.length === 0) return true;

    for (const pattern of patterns) {
      if (this.matchPattern(pattern, url)) return true;
    }
    return false;
  }

  private matchPattern(pattern: string, url: string): boolean {
    if (pattern === url) return true;
    // Wildcard: convert pattern to regex — escape special chars except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(url);
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await mkdir(this.mcpDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, content, { mode: 0o600 });
    await rename(tmpPath, filePath);
    await chmod(filePath, 0o600);
  }
}
