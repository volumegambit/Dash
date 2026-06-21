import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { PluginAuthor, PluginManifest } from '@dash/plugin-sdk';

/** Claude Code: the manifest lives at `<pluginRoot>/.claude-plugin/plugin.json`. */
export const MANIFEST_DIR = '.claude-plugin';
export const MANIFEST_FILENAME = 'plugin.json';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function normalizePaths(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  return stringArray(v);
}

/** An array of strings, or `undefined` if `v` is anything else. */
function stringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

/** Keep a recognized string field, or `undefined`. */
function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Reconstructs a `PluginAuthor` field-by-field (never spreads the raw object —
 * keeps the prototype-pollution-safe reconstruction this module uses). Requires
 * a non-null, non-array object with a string `name`; otherwise `undefined`.
 */
function normalizeAuthor(v: unknown): PluginAuthor | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  if (typeof a.name !== 'string') return undefined;
  return {
    name: a.name,
    ...(typeof a.email === 'string' ? { email: a.email } : {}),
    ...(typeof a.url === 'string' ? { url: a.url } : {}),
  };
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
    displayName: optString(m.displayName),
    version: optString(m.version),
    description: optString(m.description),
    author: normalizeAuthor(m.author),
    homepage: optString(m.homepage),
    repository: optString(m.repository),
    license: optString(m.license),
    keywords: stringArray(m.keywords),
    skills: normalizePaths(m.skills),
    commands: normalizePaths(m.commands),
    agents: normalizePaths(m.agents),
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

/** Absolute path of `rel` resolved against `dir`, but only if it exists AND stays within `dir`. */
export function containedPath(dir: string, rel: string): string | undefined {
  if (!rel.startsWith('./')) return undefined;
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  if (r.startsWith('..') || isAbsolute(r)) return undefined;
  return existsSync(abs) ? abs : undefined;
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
    const abs = containedPath(dir, p);
    if (abs) dirs.push(abs);
  }
  return dirs;
}

/** Flat `commands/*.md` files. Manifest `commands` REPLACES the default `commands/` scan. */
export function resolveCommandFiles(dir: string, manifest: PluginManifest): string[] {
  const roots = manifest.commands?.length
    ? manifest.commands.map((p) => containedPath(dir, p)).filter((p): p is string => !!p)
    : existsSync(join(dir, 'commands'))
      ? [join(dir, 'commands')]
      : [];
  const files: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(root, entry.name));
    }
  }
  return files;
}

/**
 * Resolves the subagent `*.md` files a plugin contributes: the default
 * `agents/` dir (when present) PLUS any `agents` manifest entries (relative,
 * './'-prefixed, contained). Claude Code semantics: `agents` ADDS to the
 * default, never replaces it. A manifest entry may point at a directory (scanned
 * for flat `*.md` files) or directly at an `.md` file. Markdown only — no code
 * execution, so no trust is required.
 */
export function resolveAgentFiles(dir: string, manifest: PluginManifest): string[] {
  const roots: string[] = [];
  const def = join(dir, 'agents');
  if (existsSync(def)) roots.push(def);
  for (const p of manifest.agents ?? []) {
    const abs = containedPath(dir, p);
    if (abs) roots.push(abs);
  }
  const files: string[] = [];
  for (const root of roots) {
    if (statSync(root).isDirectory()) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(root, entry.name));
      }
    } else if (root.endsWith('.md')) {
      files.push(root);
    }
  }
  return files;
}

/** The plugin's `bin/` dir, if present. */
export function resolveBinDir(dir: string): string | undefined {
  const bin = join(dir, 'bin');
  return existsSync(bin) ? bin : undefined;
}
