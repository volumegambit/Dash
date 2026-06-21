import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readHooksJson } from './hooks-manifest.js';
import { readManifest, resolveBinDir, resolveCommandFiles, resolveSkillDirs } from './manifest.js';
import { translateMcpJson } from './mcp-translate.js';
import type {
  HookConfigEntry,
  LoadedPlugins,
  McpConfigEntry,
  PluginEntryConfig,
  PluginRecord,
} from './types.js';

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
  const commandFiles: Array<{ pluginName: string; file: string }> = [];
  const binDirs: string[] = [];
  const mcpConfigs: McpConfigEntry[] = [];
  const hookConfigs: HookConfigEntry[] = [];

  for (const [discoveredName, { dir, entry, fromPath }] of targets) {
    // `phase` tracks where in this plugin's load we are, so the catch can
    // attribute a throw correctly: 'manifest' until the manifest is read,
    // then 'route' while resolving/translating components (e.g. .mcp.json).
    let phase: 'manifest' | 'route' = 'manifest';
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

      // From here on, failures are 'route' failures (component resolution).
      phase = 'route';

      // Accumulate this plugin's components into LOCALS first. We only merge
      // them into the returned aggregates once the WHOLE plugin succeeds
      // (including .mcp.json parse+translate). That keeps per-plugin activation
      // atomic: if anything below throws, the catch records an `error` and
      // NOTHING from this plugin leaks into the aggregate output.
      const localSkillDirs: string[] = [];
      const localCommandFiles: Array<{ pluginName: string; file: string }> = [];
      const localBinDirs: string[] = [];
      const localMcpConfigs: McpConfigEntry[] = [];
      const localHookConfigs: HookConfigEntry[] = [];

      // Markdown components need no trust. Skills (default skills/ + manifest
      // entries) and commands (flat .md files) are discovered for any enabled
      // plugin.
      const sDirs = resolveSkillDirs(dir, manifest);
      const cmdFiles = resolveCommandFiles(dir, manifest);
      localSkillDirs.push(...sDirs);
      localCommandFiles.push(...cmdFiles.map((file) => ({ pluginName: manifest.name, file })));

      const activated: string[] = [];
      const noop: string[] = [];
      if (sDirs.length) activated.push('skills');
      else noop.push('skills');
      if (cmdFiles.length) activated.push('commands');

      // Code-execution components (bin/, MCP servers) require explicit trust.
      // Path entries are auto-ENABLED (dev intent) but NOT auto-trusted.
      const trusted = entry.trusted === true;

      const binDir = resolveBinDir(dir);
      if (binDir) {
        if (trusted) {
          localBinDirs.push(binDir);
          activated.push('bin');
        } else {
          noop.push('bin');
        }
      }

      const mcpPath = join(dir, '.mcp.json');
      if (existsSync(mcpPath)) {
        if (trusted) {
          // parse + translate may throw on malformed config → caught below as a
          // 'route' failure for THIS plugin only (loop is fail-isolated). Because
          // we accumulate into locals, a throw here discards every component above.
          const raw = JSON.parse(readFileSync(mcpPath, 'utf8'));
          const cfgs = translateMcpJson(raw, manifest.name);
          for (const config of cfgs) localMcpConfigs.push({ pluginName: manifest.name, config });
          if (cfgs.length) activated.push('mcp');
          else noop.push('mcp');
        } else {
          noop.push('mcp');
        }
      }

      // Hooks run shell (code execution) → trust-gated, same as bin/MCP.
      const hooksPath = join(dir, 'hooks', 'hooks.json');
      if (existsSync(hooksPath)) {
        if (trusted) {
          // readHooksJson parses + validates; a malformed file throws → caught
          // below as a 'route' failure for THIS plugin only. Accumulating into
          // locals means a throw discards every component above (atomic).
          const config = await readHooksJson(dir);
          if (Object.keys(config).length) {
            localHookConfigs.push({ pluginName: manifest.name, pluginRoot: dir, config });
            activated.push('hooks');
          } else {
            // File present but no events → present-but-inactive (matches .mcp.json).
            noop.push('hooks');
          }
        } else {
          noop.push('hooks');
        }
      }

      // Plugin fully succeeded — commit its components to the aggregates.
      skillDirs.push(...localSkillDirs);
      commandFiles.push(...localCommandFiles);
      binDirs.push(...localBinDirs);
      mcpConfigs.push(...localMcpConfigs);
      hookConfigs.push(...localHookConfigs);

      records.push({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        status: 'loaded',
        dir,
        skillDirs: sDirs,
        activated,
        noop,
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
        failure: { phase, error: message, failedAt: new Date().toISOString() },
      });
    }
  }

  return { records, skillDirs, commandFiles, binDirs, mcpConfigs, hookConfigs };
}
