import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readManifest, resolveSkillDirs } from './manifest.js';
import type { LoadedPlugins, PluginEntryConfig, PluginRecord } from './types.js';

export interface LoadPluginsOptions {
  /** Directory holding installed plugins (one subdir per plugin), e.g. <dataDir>/plugins. */
  pluginsDir: string;
  /** Enable/trust + path entries from PluginConfigStore. */
  entries: Record<string, PluginEntryConfig>;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/**
 * Discovers Claude Code plugins and routes their skills. Discovery order:
 * explicit `path:` entries first (auto-enabled — explicit intent), then
 * subdirectories of `pluginsDir` (which require `enabled: true`). Each plugin
 * is loaded in isolation: a throw becomes an `error` PluginRecord and never
 * aborts the others, so the host always starts.
 */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugins> {
  const targets = new Map<string, { dir: string; entry: PluginEntryConfig; fromPath: boolean }>();

  // 1. Explicit path entries (highest precedence, auto-enabled).
  for (const [name, entry] of Object.entries(opts.entries)) {
    if (entry.path) {
      targets.set(name, { dir: resolve(entry.path), entry, fromPath: true });
    }
  }

  // 2. Installed plugins under pluginsDir. The directory read is isolated in
  // its own try/catch: a missing dir (ENOENT), a symlink-to-file (ENOTDIR), or
  // an unreadable dir (EACCES) must not abort the loader — and therefore must
  // not abort gateway boot. Rely on the single readdirSync syscall (no
  // existsSync pre-check) to avoid a TOCTOU race.
  try {
    for (const d of readdirSync(opts.pluginsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || targets.has(d.name)) continue;
      targets.set(d.name, {
        dir: join(opts.pluginsDir, d.name),
        entry: opts.entries[d.name] ?? { enabled: false },
        fromPath: false,
      });
    }
  } catch (err) {
    opts.logger?.warn(
      `[plugins] could not scan pluginsDir '${opts.pluginsDir}': ${(err as Error).message}`,
    );
  }

  const records: PluginRecord[] = [];
  const skillDirs: string[] = [];

  for (const [discoveredName, { dir, entry, fromPath }] of targets) {
    try {
      const manifest = await readManifest(dir);
      const enabled = fromPath || entry.enabled;
      if (!enabled) {
        records.push({
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          status: 'disabled',
          dir,
          skillDirs: [],
          activated: [],
          noop: ['skills'],
        });
        continue;
      }
      const sDirs = resolveSkillDirs(dir, manifest);
      skillDirs.push(...sDirs);
      const activated = sDirs.length > 0 ? ['skills'] : [];
      records.push({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        status: 'loaded',
        dir,
        skillDirs: sDirs,
        activated,
        noop: sDirs.length > 0 ? [] : ['skills'],
      });
      opts.logger?.info(
        `[plugins] loaded '${manifest.name}' (${activated.join(', ') || 'no components'})`,
      );
    } catch (err) {
      const message = (err as Error).message;
      opts.logger?.warn(`[plugins] failed to load '${discoveredName}': ${message}`);
      records.push({
        name: discoveredName,
        status: 'error',
        dir,
        skillDirs: [],
        activated: [],
        noop: [],
        failure: { phase: 'manifest', error: message, failedAt: new Date().toISOString() },
      });
    }
  }

  return { records, skillDirs };
}
