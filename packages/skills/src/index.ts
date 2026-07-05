import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the built-in plugins directory.
 *
 * The `plugins/` directory lives at the package root (sibling of `src/` and
 * `dist/`), so resolving one level up from this module's directory works
 * whether running from source (`src/index.ts`) or built output (`dist/index.js`).
 */
export function getBuiltinPluginsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins');
}

/** The built-in plugins shipped with Dash (one per skill suite). */
export const BUILTIN_PLUGINS = [
  'dash-assistant',
  'dash-comms',
  'dash-creative',
  'dash-dev',
  'dash-meta',
] as const;

export type BuiltinPluginName = (typeof BUILTIN_PLUGINS)[number];
