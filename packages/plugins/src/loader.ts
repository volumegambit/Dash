import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readHooksJson } from './hooks-manifest.js';
import {
  readManifest,
  resolveAgentFiles,
  resolveBinDir,
  resolveCommandFiles,
  resolveProviderFiles,
  resolveSkillDirs,
} from './manifest.js';
import { translateMcpJson } from './mcp-translate.js';
import { validateProviderCatalog } from './provider-catalog.js';
import type {
  HookConfigEntry,
  LoadedPlugins,
  McpConfigEntry,
  PluginEntryConfig,
  PluginRecord,
  ProviderConfigEntry,
} from './types.js';

/**
 * The bundled core-providers plugin. Loaded FIRST (before all other plugins,
 * which load alphabetically) so it deterministically claims its reserved
 * provider ids regardless of filesystem readdir order.
 */
export const RESERVED_FIRST_PLUGIN = 'dash-core-providers';

/**
 * The provider ids owned by the bundled dash-core-providers plugin — see
 * excludeCoreProviderCollisions. These are the reserved core provider ids
 * (formerly a static allow-list; now the single source is the bundled catalogs).
 */
export const RESERVED_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'moonshotai',
  'openrouter',
] as const;

export interface LoadPluginsOptions {
  /** Directory holding installed plugins (one subdir per plugin), e.g. <dataDir>/plugins. */
  pluginsDir: string;
  /** Enable/trust + path entries from PluginConfigStore. */
  entries: Record<string, PluginEntryConfig>;
  /**
   * Optional directory of built-in plugins shipped with the host (one subdir
   * per plugin). Scanned LAST so a user plugin (path entry or pluginsDir
   * subdir) of the same name wins; the shadowed builtin surfaces as an error
   * record. Builtins are enabled by default — config entries store overrides
   * only — and follow the same trust gate as any other plugin.
   */
  builtinRoot?: string;
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
  const targets = new Map<
    string,
    { dir: string; entry: PluginEntryConfig; fromPath: boolean; builtin?: boolean }
  >();

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
    // Deterministic load order: the bundled core-providers plugin first (it
    // owns reserved provider ids — see the gateway's reserved-id rule), then
    // alphabetical. readdir order is filesystem-dependent; never rely on it.
    const dirents = readdirSync(opts.pluginsDir, { withFileTypes: true }).sort((a, b) => {
      if (a.name === RESERVED_FIRST_PLUGIN) return -1;
      if (b.name === RESERVED_FIRST_PLUGIN) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const d of dirents) {
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

  // 3. Built-in plugins (shipped with the host). Scanned LAST: a user plugin
  // of the same name wins; the shadowed builtin is surfaced as an error
  // record (never silently dropped). Same fail-isolated readdir as step 2.
  const shadowedBuiltins: Array<{ name: string; dir: string }> = [];
  if (opts.builtinRoot) {
    try {
      for (const d of readdirSync(opts.builtinRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = join(opts.builtinRoot, d.name);
        if (targets.has(d.name)) {
          shadowedBuiltins.push({ name: d.name, dir });
          continue;
        }
        targets.set(d.name, {
          dir,
          entry: opts.entries[d.name] ?? { enabled: true },
          fromPath: false,
          builtin: true,
        });
      }
    } catch (err) {
      opts.logger?.warn(
        `[plugins] could not scan builtinRoot '${opts.builtinRoot}': ${(err as Error).message}`,
      );
    }
  }

  const records: PluginRecord[] = [];
  const skillDirs: string[] = [];
  const commandFiles: Array<{ pluginName: string; file: string }> = [];
  const agentFiles: Array<{ pluginName: string; file: string }> = [];
  const binDirs: string[] = [];
  const mcpConfigs: McpConfigEntry[] = [];
  const hookConfigs: HookConfigEntry[] = [];
  const providerConfigs: ProviderConfigEntry[] = [];

  for (const { name, dir } of shadowedBuiltins) {
    opts.logger?.warn(
      `[plugins] built-in plugin '${name}' is shadowed by a user plugin of the same name`,
    );
    records.push({
      name,
      status: 'error',
      dir,
      skillDirs: [],
      activated: [],
      noop: [],
      builtin: true,
      failure: {
        phase: 'discovery',
        error: 'shadowed by a user plugin of the same name',
        failedAt: new Date().toISOString(),
      },
    });
  }

  for (const [discoveredName, { dir, entry, fromPath, builtin }] of targets) {
    // `phase` tracks where in this plugin's load we are, so the catch can
    // attribute a throw correctly: 'manifest' until the manifest is read,
    // then 'route' while resolving/translating components (e.g. .mcp.json).
    let phase: 'manifest' | 'route' = 'manifest';
    try {
      const manifest = await readManifest(dir);
      // Builtins are enabled unless explicitly disabled (overrides-only
      // config); installed plugins require an explicit enabled:true.
      const enabled = fromPath || (builtin ? entry.enabled !== false : entry.enabled);
      if (!enabled) {
        records.push({
          name: manifest.name,
          displayName: manifest.displayName,
          version: manifest.version,
          description: manifest.description,
          status: 'disabled',
          dir,
          skillDirs: [],
          activated: [],
          noop: ['skills'],
          builtin: builtin || undefined,
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
      const localAgentFiles: Array<{ pluginName: string; file: string }> = [];
      const localBinDirs: string[] = [];
      const localMcpConfigs: McpConfigEntry[] = [];
      const localHookConfigs: HookConfigEntry[] = [];
      const localProviderConfigs: ProviderConfigEntry[] = [];

      // Markdown components need no trust. Skills (default skills/ + manifest
      // entries), commands (flat .md files), and agents (loadable specialist
      // .md files) are discovered for any enabled plugin.
      const sDirs = resolveSkillDirs(dir, manifest);
      const cmdFiles = resolveCommandFiles(dir, manifest);
      const agtFiles = resolveAgentFiles(dir, manifest);
      localSkillDirs.push(...sDirs);
      localCommandFiles.push(...cmdFiles.map((file) => ({ pluginName: manifest.name, file })));
      localAgentFiles.push(...agtFiles.map((file) => ({ pluginName: manifest.name, file })));

      const activated: string[] = [];
      const noop: string[] = [];
      if (sDirs.length) activated.push('skills');
      else noop.push('skills');
      if (cmdFiles.length) activated.push('commands');
      if (agtFiles.length) activated.push('agents');

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

      // Provider catalogs are credential-bearing (they declare a provider the
      // host stores API keys for) → trust-gated, same as bin/MCP/hooks. The
      // file set is the default providers/ scan PLUS manifest `providers`
      // entries (both honored only when trusted). A plugin DECLARES intent to
      // provide providers when its manifest lists `providers`, OR a providers/
      // dir exists, OR resolution found catalog files — so the untrusted skip
      // records a `noop: 'providers'` for any of these, not just non-empty
      // resolution (mirrors the bin/MCP/hooks trust-gating idiom).
      const providerFiles = resolveProviderFiles(dir, manifest);
      const declaresProviders =
        (manifest.providers?.length ?? 0) > 0 ||
        existsSync(join(dir, 'providers')) ||
        providerFiles.length > 0;
      if (declaresProviders) {
        if (trusted) {
          // Parse + validate each catalog; a malformed file throws → caught
          // below as a 'route' failure for THIS plugin only. Accumulating into
          // locals means a throw discards every component above (atomic).
          for (const file of providerFiles) {
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            const catalog = validateProviderCatalog(raw);
            localProviderConfigs.push({ pluginName: manifest.name, catalog });
          }
          if (providerFiles.length) activated.push('providers');
          else noop.push('providers');
        } else {
          noop.push('providers');
        }
      }

      // Plugin fully succeeded — commit its components to the aggregates.
      skillDirs.push(...localSkillDirs);
      commandFiles.push(...localCommandFiles);
      agentFiles.push(...localAgentFiles);
      binDirs.push(...localBinDirs);
      mcpConfigs.push(...localMcpConfigs);
      hookConfigs.push(...localHookConfigs);
      providerConfigs.push(...localProviderConfigs);

      records.push({
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        description: manifest.description,
        status: 'loaded',
        dir,
        skillDirs: sDirs,
        activated,
        noop,
        builtin: builtin || undefined,
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
        builtin: builtin || undefined,
        failure: { phase, error: message, failedAt: new Date().toISOString() },
      });
    }
  }

  return {
    records,
    skillDirs,
    commandFiles,
    agentFiles,
    binDirs,
    mcpConfigs,
    hookConfigs,
    providerConfigs,
  };
}
