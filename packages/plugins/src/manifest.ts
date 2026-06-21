import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
    providers: normalizePaths(m.providers),
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
 * Realpath-based containment: true only if the CANONICAL (symlink-resolved)
 * `candidateAbs` lives inside the CANONICAL `baseDir`. This closes the
 * symlink-escape hole left by a purely lexical check — a path whose lexical
 * form stays inside the plugin dir but whose realpath resolves outside (e.g. a
 * `skills` symlink pointing at `/etc`) is rejected. Fail-isolated: a throwing
 * `realpathSync` (dangling/broken symlink, unreadable, ENOENT) returns `false`
 * (treated as not-contained) and never crashes the loader.
 */
export function realpathContained(baseDir: string, candidateAbs: string): boolean {
  try {
    const realBase = realpathSync(baseDir);
    const realCand = realpathSync(candidateAbs);
    const r = relative(realBase, realCand);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  } catch {
    return false;
  }
}

/**
 * Absolute path of `rel` resolved against `dir`, but only if it exists AND
 * stays within `dir` BOTH lexically and after symlink resolution. Returns the
 * ORIGINAL lexical `abs` (never the canonicalized realpath) so legitimate paths
 * like `/tmp/...` are not rewritten to `/private/tmp/...` on macOS — realpath is
 * used ONLY for the containment guard.
 */
export function containedPath(dir: string, rel: string): string | undefined {
  if (!rel.startsWith('./')) return undefined;
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  if (r.startsWith('..') || isAbsolute(r)) return undefined;
  if (!existsSync(abs)) return undefined;
  if (!realpathContained(dir, abs)) return undefined;
  return abs;
}

/**
 * Resolves the skill directories a plugin contributes: the default `skills/`
 * dir (when present) PLUS any `skills` manifest entries (relative, './'-prefixed,
 * existing). Claude Code semantics: `skills` ADDS to the default, never replaces.
 */
export function resolveSkillDirs(dir: string, manifest: PluginManifest): string[] {
  const dirs: string[] = [];
  const def = join(dir, 'skills');
  // Default root bypasses containedPath, so guard it directly: a `skills`
  // symlink whose realpath escapes the plugin dir must NOT be scanned.
  if (existsSync(def) && realpathContained(dir, def)) dirs.push(def);
  for (const p of manifest.skills ?? []) {
    const abs = containedPath(dir, p);
    if (abs) dirs.push(abs);
  }
  return dirs;
}

/**
 * Flat `*.<ext>` files directly under `root`, skipping any per-file entry whose
 * own realpath escapes `pluginDir` (a per-file symlink inside an otherwise
 * contained dir). Hardened: a missing / unreadable / non-dir (ENOTDIR) `root`
 * yields no files instead of throwing, so one bad component is DROPPED rather
 * than downgrading the whole plugin to an `error` record.
 */
function scanFlatFiles(pluginDir: string, root: string, ext: string): string[] {
  let entries: Dirent[];
  try {
    if (!statSync(root).isDirectory()) return [];
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(ext)) continue;
    const abs = join(root, entry.name);
    // Regular file → fast path. Symlink (or anything non-file) → only accept if
    // it resolves to a real file still contained within the plugin dir.
    if (entry.isFile()) {
      files.push(abs);
    } else if (realpathContained(pluginDir, abs) && safeIsFile(abs)) {
      files.push(abs);
    }
  }
  return files;
}

/** True if `abs` resolves to a regular file; false on any stat error. */
function safeIsFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Flat `commands/*.md` files. Manifest `commands` REPLACES the default `commands/` scan. */
export function resolveCommandFiles(dir: string, manifest: PluginManifest): string[] {
  let roots: string[];
  if (manifest.commands?.length) {
    roots = manifest.commands.map((p) => containedPath(dir, p)).filter((p): p is string => !!p);
  } else {
    const def = join(dir, 'commands');
    // Default root bypasses containedPath — guard against a `commands` symlink
    // whose realpath escapes the plugin dir.
    roots = existsSync(def) && realpathContained(dir, def) ? [def] : [];
  }
  const files: string[] = [];
  for (const root of roots) {
    files.push(...scanFlatFiles(dir, root, '.md'));
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
  // Default root bypasses containedPath — guard against an `agents` symlink
  // whose realpath escapes the plugin dir.
  if (existsSync(def) && realpathContained(dir, def)) roots.push(def);
  for (const p of manifest.agents ?? []) {
    const abs = containedPath(dir, p);
    if (abs) roots.push(abs);
  }
  const files: string[] = [];
  for (const root of roots) {
    // A root may be a directory (scanned for flat *.md) or a direct *.md file.
    let isDir = false;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      // Broken/unreadable/ENOTDIR root — drop this component, don't throw.
      continue;
    }
    if (isDir) {
      files.push(...scanFlatFiles(dir, root, '.md'));
    } else if (root.endsWith('.md')) {
      files.push(root);
    }
  }
  return files;
}

/**
 * Resolves the provider-catalog `*.json` files a plugin contributes: the
 * default `providers/` dir (when present) PLUS any `providers` manifest entries
 * (relative, './'-prefixed, contained). Claude/Dash semantics: `providers` ADDS
 * to the default, never replaces it. A manifest entry may point at a directory
 * (scanned for flat `*.json` files) or directly at a `.json` file. The returned
 * list is deduped, preserving first-seen order. Provider catalogs are
 * credential-bearing, so the loader only honors these for TRUSTED plugins.
 *
 * The directory scan is hardened (try/catch around stat/readdir): a symlinked
 * or unreadable provider dir must NOT crash the loader. Per-file symlinks that
 * escape the plugin dir are skipped (see `scanFlatFiles`).
 */
export function resolveProviderFiles(dir: string, manifest: PluginManifest): string[] {
  const roots: string[] = [];
  const def = join(dir, 'providers');
  // Default root bypasses containedPath — guard against a `providers` symlink
  // whose realpath escapes the plugin dir.
  if (existsSync(def) && realpathContained(dir, def)) roots.push(def);
  for (const p of manifest.providers ?? []) {
    const abs = containedPath(dir, p);
    if (abs) roots.push(abs);
  }
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    if (!seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  };
  for (const root of roots) {
    let isDir = false;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      for (const file of scanFlatFiles(dir, root, '.json')) add(file);
    } else if (root.endsWith('.json')) {
      add(root);
    }
  }
  return files;
}

/** The plugin's `bin/` dir, if present. */
export function resolveBinDir(dir: string): string | undefined {
  const bin = join(dir, 'bin');
  return existsSync(bin) ? bin : undefined;
}
