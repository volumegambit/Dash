import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@dash/logging';
import type { PluginConfigStore } from '@dash/plugins';

const PLUGIN_NAME = 'dash-core-providers';
const MANIFEST_REL = join('.claude-plugin', 'plugin.json');

export interface EnsureCoreProvidersPluginOptions {
  /** Gateway data dir; the plugin installs under `<dataDir>/plugins/<name>`. */
  dataDir: string;
  /** Shipped bundle source dir (inside the gateway package). */
  bundledDir: string;
  configStore: PluginConfigStore;
  logger: Logger;
}

/** Read a plugin manifest's `version`, or `undefined` if unreadable/malformed. */
async function readManifestVersion(dir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(dir, MANIFEST_REL), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>).version;
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    // Missing or corrupt manifest → treat as "needs (re)copy".
  }
  return undefined;
}

/**
 * Idempotently install the bundled `dash-core-providers` plugin into
 * `<dataDir>/plugins/dash-core-providers` and ensure its config entry is
 * enabled + trusted. Called at gateway boot BEFORE loading plugin entries so
 * this boot (not the next) serves its catalogs.
 *
 * Copy happens when the target is missing OR when the bundled manifest version
 * differs from the installed one (a corrupt/absent installed manifest reads as
 * `undefined`, forcing a re-copy). The copy is a clean `rm` + recursive `cp` so
 * a version bump never leaves stale files behind.
 *
 * The four config fields are (re)asserted on EVERY boot, even when up-to-date:
 * the gateway cannot run without providers, so a user who untrusts or disables
 * the bundled plugin gets it re-trusted/re-enabled next boot. Disabling core
 * providers is a per-agent concern (Phase 4), not something done by untrusting
 * this system plugin.
 *
 * Throws on a missing bundled dir or copy failure — the caller treats it as
 * boot-fatal (a gateway with zero providers is broken, and the bundle ships
 * inside the package so there is no legitimate missing-file case).
 */
export async function ensureCoreProvidersPlugin(
  opts: EnsureCoreProvidersPluginOptions,
): Promise<void> {
  const { dataDir, bundledDir, configStore, logger } = opts;

  const bundledVersion = await readManifestVersion(bundledDir);
  if (!bundledVersion) {
    throw new Error(
      `bundled ${PLUGIN_NAME} plugin missing or unreadable at ${join(bundledDir, MANIFEST_REL)}`,
    );
  }

  const installedDir = join(dataDir, 'plugins', PLUGIN_NAME);
  const installedVersion = await readManifestVersion(installedDir);

  if (installedVersion !== bundledVersion) {
    const was = installedVersion ? ` (was v${installedVersion})` : '';
    logger.info(`[plugins] installing bundled ${PLUGIN_NAME} v${bundledVersion}${was}`);
    // Clean upgrade: remove any prior copy so a version bump can't leave stale
    // files, then copy the whole bundle recursively.
    await rm(installedDir, { recursive: true, force: true });
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await cp(bundledDir, installedDir, { recursive: true, force: true });
  } else {
    logger.debug(`[plugins] bundled ${PLUGIN_NAME} v${bundledVersion} up to date`);
  }

  // Always (re)assert the config: enabled + trusted are required for the
  // gateway to serve providers at all (see doc comment above).
  await configStore.setEnabled(PLUGIN_NAME, true);
  await configStore.setTrusted(PLUGIN_NAME, true);
  await configStore.setInstalled(PLUGIN_NAME, true);
  await configStore.setSource(PLUGIN_NAME, `bundled://${bundledVersion}`);
}
