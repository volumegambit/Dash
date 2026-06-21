import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { PluginManifest } from '@dash/plugin-sdk';

/** Claude Code: the manifest lives at `<pluginRoot>/.claude-plugin/plugin.json`. */
export const MANIFEST_DIR = '.claude-plugin';
export const MANIFEST_FILENAME = 'plugin.json';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function normalizePaths(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

/**
 * Validates a parsed manifest object against Claude Code semantics: only
 * `name` is meaningful-required (absent → directory basename), it must be
 * kebab-case, and unrecognized top-level fields are dropped (ignored).
 */
export function validateManifest(raw: unknown, dir: string): PluginManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('plugin.json must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  const name = typeof m.name === 'string' && m.name.length > 0 ? m.name : basename(dir);
  if (!KEBAB_CASE.test(name)) {
    throw new Error(`plugin 'name' must be kebab-case, got '${name}'`);
  }
  return {
    name,
    displayName: typeof m.displayName === 'string' ? m.displayName : undefined,
    version: typeof m.version === 'string' ? m.version : undefined,
    description: typeof m.description === 'string' ? m.description : undefined,
    skills: normalizePaths(m.skills),
    commands: normalizePaths(m.commands),
  };
}

/**
 * Reads `<dir>/.claude-plugin/plugin.json`. The manifest is OPTIONAL: when
 * absent, the plugin is named after its directory (which must be kebab-case).
 */
export async function readManifest(dir: string): Promise<PluginManifest> {
  const path = join(dir, MANIFEST_DIR, MANIFEST_FILENAME);
  if (!existsSync(path)) {
    const name = basename(dir);
    if (!KEBAB_CASE.test(name)) {
      throw new Error(
        `plugin at ${dir} has no ${MANIFEST_DIR}/${MANIFEST_FILENAME} and dir name '${name}' is not kebab-case`,
      );
    }
    return { name };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  return validateManifest(raw, dir);
}

/**
 * Resolves the skill directories a plugin contributes: the default `skills/`
 * dir (when present) PLUS any `skills` manifest entries (relative, './'-prefixed,
 * existing). Claude Code semantics: `skills` ADDS to the default, never replaces.
 */
export function resolveSkillDirs(dir: string, manifest: PluginManifest): string[] {
  const dirs: string[] = [];
  const def = join(dir, 'skills');
  if (existsSync(def)) dirs.push(def);
  for (const p of manifest.skills ?? []) {
    if (!p.startsWith('./')) continue;
    const abs = resolve(dir, p);
    if (existsSync(abs)) dirs.push(abs);
  }
  return dirs;
}
