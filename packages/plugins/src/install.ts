import type { Dirent } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { extract } from 'tar';
import { gitCloneToTemp } from './git.js';
import { readManifest, realpathContained } from './manifest.js';
import type { PluginScanVerdict } from './scanner.js';

export type { PluginScanVerdict } from './scanner.js';

/**
 * Plugin install error codes. Used by {@link PluginOpError} and mapped to HTTP
 * statuses by the gateway's `mapPluginError`.
 */
export type PluginOpCode =
  | 'not_found' // marketplace entry not found / source fetch failed
  | 'duplicate' // plugin with this name already exists
  | 'invalid_manifest' // manifest not kebab-case, missing name
  | 'corrupt_archive' // tarball extract failed (broken archive, bad permissions)
  | 'scan_failed' // heuristic scan threw (unusual)
  | 'dangerous' // scan verdict is dangerous
  | 'untrusted'; // (unused in this task; defer per-agent trust visibility)

/**
 * Error carrying a structured {@link PluginOpCode}. The gateway inspects `code`
 * to choose an HTTP status; everything else falls through to 500.
 */
export class PluginOpError extends Error {
  constructor(
    readonly code: PluginOpCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginOpError';
  }
}

/**
 * A parsed plugin install source. Mirrors the skill installer's
 * `ParsedSkillSource` shape so the two install flows stay aligned, but is
 * re-implemented here to avoid `@dash/plugins` depending on `@dash/agent`.
 */
export type ParsedPluginSource =
  | { kind: 'git'; owner: string; repo: string; subpath?: string; ref?: string }
  | { kind: 'url'; url: string }
  | { kind: 'local'; path: string };

/**
 * Parse a plugin install source. Supported forms (identical to the skill
 * installer):
 * - `git:owner/repo[/subpath][@ref]`
 * - `http(s)://…` URL
 * - a local filesystem path (absolute, relative, or `~/`)
 *
 * Empty or malformed git input throws.
 */
export function parsePluginSource(raw: string): ParsedPluginSource {
  const s = raw.trim();

  if (!s) {
    throw new Error('Invalid plugin source: empty.');
  }

  if (s.startsWith('git:')) {
    let rest = s.slice(4);
    let ref: string | undefined;
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      ref = rest.slice(at + 1) || undefined;
      rest = rest.slice(0, at);
    }
    const parts = rest.split('/').filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`Invalid git source "${raw}". Expected git:owner/repo[/subpath][@ref].`);
    }
    const [owner, repo, ...sub] = parts;
    return { kind: 'git', owner, repo, subpath: sub.length ? sub.join('/') : undefined, ref };
  }

  if (s.startsWith('http://') || s.startsWith('https://')) {
    return { kind: 'url', url: s };
  }

  return { kind: 'local', path: s };
}

/** A plugin fetched into a temp dir, ready to be scanned and moved into place. */
interface FetchedPlugin {
  /** Absolute path to the extracted plugin root (lives under the OS temp dir). */
  dir: string;
  /**
   * The `mkdtemp` root that owns `dir` and must be removed on cleanup. `dir` may
   * be a subpath beneath it (a git subpath, or a single wrapping directory
   * inside an extracted tarball), so the two can differ.
   */
  cleanupRoot: string;
  /**
   * A name derived from the SOURCE (local dir basename, git repo/subpath, or url
   * filename) — used as the install name only when neither the manifest nor an
   * explicit override supplies one. Decoupled from `dir` because `dir` is a
   * random `mkdtemp` path whose basename is not a meaningful plugin name.
   */
  fallbackName: string;
}

/** Options for {@link installPluginToDir}. */
export interface PluginInstallOptions {
  /** The Dash data directory; the plugin lands at `<dataDir>/plugins/<name>`. */
  dataDir: string;
  /** A `git:`/`http(s):` URL or a local filesystem path (see {@link parsePluginSource}). */
  source: string;
  /** Optional plugin-name override. The manifest's `name` still wins if present. */
  name?: string;
  /**
   * Security scan run against the fetched plugin root before it is moved into
   * place. Injected so callers can substitute a stub in tests; production passes
   * {@link heuristicPluginScan}. A throw maps to `scan_failed`; a `dangerous`
   * verdict maps to `dangerous`.
   */
  scanner: (pluginDir: string) => Promise<PluginScanVerdict>;
}

/** The record returned by a successful {@link installPluginToDir}. */
export interface InstalledPlugin {
  name: string;
  version?: string;
  description?: string;
  /** Absolute path to the installed plugin (`<dataDir>/plugins/<name>`). */
  location: string;
  /** The scan verdict the plugin landed with (may be `suspicious`). */
  verdict: PluginScanVerdict;
  /** The original `source` string passed to {@link installPluginToDir}. */
  source: string;
}

/** The default GitHub remote URL for a `git:owner/repo` source. */
export function defaultGitRemote(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/** Expand a leading `~/` to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Extract a `.tar.gz` buffer into `destDir` with a hard zip-slip guard. Defense
 * in depth: `tar`'s own `onentry` callback rejects any member whose resolved
 * path escapes `destDir` (`../`, absolute, or otherwise), AND every settled
 * entry path is re-checked with {@link realpathContained} (which resolves
 * symlinks) — so neither a crafted member path NOR a symlink target can write
 * outside the destination. `strip` is NOT used, so member paths are honored
 * verbatim and a malicious `../` is not silently absorbed.
 *
 * Any failure throws {@link PluginOpError} with code `corrupt_archive`; a
 * zip-slip attempt is reported as `attempted zip-slip escape at <entry>`.
 */
async function extractTarball(buf: Buffer, destDir: string): Promise<void> {
  const realDest = await realpathOrSelf(destDir);
  const escaped: string[] = [];
  const settled: string[] = [];

  /** True only if `entryPath` resolves to a path inside `realDest` (lexically). */
  const isContained = (entryPath: string): boolean => {
    // Absolute member paths escape `cwd` entirely — reject outright.
    if (isAbsolute(entryPath)) return false;
    const target = resolve(realDest, entryPath);
    return target === realDest || target.startsWith(`${realDest}/`);
  };

  try {
    await new Promise<void>((res, rej) => {
      const sink = extract({
        cwd: destDir,
        // First line of defense: never WRITE an entry that lexically escapes.
        filter: (entryPath): boolean => {
          if (isContained(entryPath)) return true;
          escaped.push(entryPath);
          return false;
        },
        // Record every entry tar accepted so we can re-verify it post-write.
        onentry: (entry): void => {
          if (isContained(entry.path)) settled.push(entry.path);
          else escaped.push(entry.path);
        },
      });
      sink.on('error', rej);
      sink.on('finish', res);
      sink.on('close', res);
      sink.end(buf);
    });
  } catch (err) {
    if (err instanceof PluginOpError) throw err;
    throw new PluginOpError('corrupt_archive', `failed to extract archive: ${errMsg(err)}`);
  }

  if (escaped.length > 0) {
    throw new PluginOpError('corrupt_archive', `attempted zip-slip escape at ${escaped[0]}`);
  }

  // Second line of defense (symlink-aware): assert every extracted path's
  // realpath is still contained. Catches a member whose target is a symlink
  // resolving outside destDir even though its lexical path looked clean.
  for (const rel of settled) {
    const abs = resolve(destDir, rel);
    if (!realpathContained(destDir, abs)) {
      throw new PluginOpError('corrupt_archive', `attempted zip-slip escape at ${rel}`);
    }
  }
}

/**
 * Resolve the plugin root inside a freshly extracted tarball. Tarballs commonly
 * wrap their contents in a single top-level directory (e.g. GitHub's
 * `repo-<sha>/...` archives). When `extractDir` contains exactly one entry and
 * that entry is a directory, descend into it; otherwise the plugin root is
 * `extractDir` itself.
 */
async function resolveExtractedRoot(extractDir: string): Promise<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(extractDir, { withFileTypes: true });
  } catch {
    return extractDir;
  }
  if (entries.length === 1 && entries[0].isDirectory()) {
    return join(extractDir, entries[0].name);
  }
  return extractDir;
}

/** Canonicalize `p`, tolerating a not-yet-canonicalizable path. */
async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Fetch a plugin from a parsed source into a fresh temp dir and return its root.
 *
 * - `git`: `git clone --depth 1 [--branch <ref>]` (full clone + `checkout` when
 *   `--branch` rejects a commit SHA). Plugin root = `<tmp>/<subpath>` or `<tmp>`.
 * - `url`: `fetch` the `.tar.gz`, then {@link extractTarball} into a temp dir.
 * - `local`: a directory is COPIED into a temp dir (never used in place — the
 *   installer MOVES the temp dir, and the user's source must survive); a
 *   `.tar.gz` file is extracted into a temp dir.
 *
 * On any failure the temp dir is cleaned up. HTTP / clone / missing-path
 * failures throw `not_found`; extraction failures throw `corrupt_archive`.
 */
async function fetchPlugin(source: ParsedPluginSource): Promise<FetchedPlugin> {
  if (source.kind === 'git') {
    const repoUrl = defaultGitRemote(source.owner, source.repo);
    let cloned: Awaited<ReturnType<typeof gitCloneToTemp>>;
    try {
      cloned = await gitCloneToTemp(repoUrl, source.ref, 'dash-plugin-git-');
    } catch (err) {
      throw new PluginOpError(
        'not_found',
        `git clone failed for ${source.owner}/${source.repo}: ${errMsg(err)}`,
      );
    }
    const fallbackName = source.subpath ? basename(source.subpath) : source.repo;
    return {
      dir: source.subpath ? join(cloned.dir, source.subpath) : cloned.dir,
      cleanupRoot: cloned.dir,
      fallbackName,
    };
  }

  if (source.kind === 'url') {
    let res: Response;
    try {
      res = await fetch(source.url);
    } catch (err) {
      throw new PluginOpError('not_found', `failed to fetch ${source.url}: ${errMsg(err)}`);
    }
    if (!res.ok) {
      throw new PluginOpError('not_found', `failed to fetch ${source.url}: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = await mkdtemp(join(tmpdir(), 'dash-plugin-url-'));
    try {
      await extractTarball(buf, tmp);
      return {
        dir: await resolveExtractedRoot(tmp),
        cleanupRoot: tmp,
        fallbackName: urlFallbackName(source.url),
      };
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  // local
  const expanded = expandHome(source.path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(expanded);
  } catch {
    throw new PluginOpError('not_found', `local plugin source not found: ${expanded}`);
  }

  if (info.isDirectory()) {
    // Copy the tree into a temp dir — the installer MOVES its result, so we must
    // never move the user's original source.
    const tmp = await mkdtemp(join(tmpdir(), 'dash-plugin-local-'));
    try {
      await cp(expanded, tmp, { recursive: true });
      return { dir: tmp, cleanupRoot: tmp, fallbackName: basename(expanded) };
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw new PluginOpError(
        'not_found',
        `failed to copy local plugin ${expanded}: ${errMsg(err)}`,
      );
    }
  }

  // A local file is treated as a `.tar.gz` archive.
  const tmp = await mkdtemp(join(tmpdir(), 'dash-plugin-local-'));
  try {
    const buf = await readFile(expanded);
    await extractTarball(buf, tmp);
    return {
      dir: await resolveExtractedRoot(tmp),
      cleanupRoot: tmp,
      fallbackName: stripArchiveExt(basename(expanded)),
    };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    if (err instanceof PluginOpError) throw err;
    throw new PluginOpError(
      'corrupt_archive',
      `failed to read archive ${expanded}: ${errMsg(err)}`,
    );
  }
}

/**
 * Install a plugin from `source` into `<dataDir>/plugins/<name>`.
 *
 * Flow: parse source → {@link fetchPlugin} into a temp dir → read the manifest
 * (canonical name = manifest.name ?? `name` override ?? source-derived fallback,
 * which must be kebab-case) → reject a duplicate install → run the injected
 * `scanner` (throw → `scan_failed`, `dangerous` → `dangerous`) → move into place.
 *
 * Trust is NOT decided here: a `suspicious` (or `safe`) plugin installs and the
 * verdict is returned for the caller to record. Config-store writes are the
 * caller's responsibility (Task 4). The temp dir is always cleaned up.
 */
export async function installPluginToDir(opts: PluginInstallOptions): Promise<InstalledPlugin> {
  const parsed = parsePluginSource(opts.source);
  const fetched = await fetchPlugin(parsed);
  const tempDir = fetched.dir;

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(fetched.cleanupRoot, { recursive: true, force: true });
  };

  try {
    // The plugin root must exist (e.g. a git subpath that isn't actually there).
    try {
      const info = await stat(tempDir);
      if (!info.isDirectory()) {
        throw new PluginOpError('not_found', `plugin root is not a directory: ${tempDir}`);
      }
    } catch (err) {
      if (err instanceof PluginOpError) throw err;
      throw new PluginOpError('not_found', `plugin root not found: ${tempDir}`);
    }

    const { manifest, finalName } = await resolveManifestAndName(
      tempDir,
      fetched.fallbackName,
      opts.name,
    );

    const installDir = join(opts.dataDir, 'plugins', finalName);
    if (await pathExists(installDir)) {
      throw new PluginOpError('duplicate', `a plugin named '${finalName}' is already installed`);
    }

    let verdict: PluginScanVerdict;
    try {
      verdict = await opts.scanner(tempDir);
    } catch (err) {
      throw new PluginOpError('scan_failed', `plugin scan failed: ${errMsg(err)}`);
    }
    if (verdict.verdict === 'dangerous') {
      throw new PluginOpError(
        'dangerous',
        verdict.reasons.join('; ') || 'plugin flagged as dangerous',
      );
    }

    await mkdir(join(opts.dataDir, 'plugins'), { recursive: true });
    await moveDir(tempDir, installDir);

    return {
      name: finalName,
      ...(manifest.version !== undefined ? { version: manifest.version } : {}),
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      location: installDir,
      verdict,
      source: opts.source,
    };
  } finally {
    await cleanup();
  }
}

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Read the manifest (if present) and decide the canonical install name.
 *
 * - When `<dir>/.claude-plugin/plugin.json` EXISTS, `readManifest` validates it
 *   and its `name` wins (a validation failure → `invalid_manifest`).
 * - When it does NOT exist, the install name is the explicit `override` if given,
 *   else the source-derived `fallbackName`; that chosen name must be kebab-case
 *   (else `invalid_manifest`), and a minimal `{ name }` manifest is synthesized.
 *
 * The source-derived fallback is used instead of `readManifest`'s directory-name
 * fallback because the plugin currently lives in a random `mkdtemp` directory.
 */
async function resolveManifestAndName(
  dir: string,
  fallbackName: string,
  override?: string,
): Promise<{ manifest: Awaited<ReturnType<typeof readManifest>>; finalName: string }> {
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  if (await pathExists(manifestPath)) {
    let manifest: Awaited<ReturnType<typeof readManifest>>;
    try {
      manifest = await readManifest(dir);
    } catch (err) {
      throw new PluginOpError('invalid_manifest', errMsg(err));
    }
    // A nameless manifest makes `readManifest` fall back to `basename(dir)` (a
    // random temp name); prefer the override/source-derived name in that case.
    const finalName =
      manifest.name === basename(dir) ? validateName(override ?? fallbackName) : manifest.name;
    return { manifest: { ...manifest, name: finalName }, finalName };
  }

  const finalName = validateName(override ?? fallbackName);
  return { manifest: { name: finalName }, finalName };
}

/** Ensure `name` is a kebab-case plugin name; otherwise `invalid_manifest`. */
function validateName(name: string): string {
  if (!KEBAB_CASE.test(name)) {
    throw new PluginOpError('invalid_manifest', `plugin name must be kebab-case, got '${name}'`);
  }
  return name;
}

/** Drop a trailing `.tar.gz`/`.tgz`/`.tar` so a tarball filename yields a name. */
function stripArchiveExt(file: string): string {
  return file
    .replace(/\.tar\.gz$/i, '')
    .replace(/\.tgz$/i, '')
    .replace(/\.tar$/i, '');
}

/** Derive a fallback name from a URL's last path segment, minus the archive ext. */
function urlFallbackName(url: string): string {
  let last = url;
  try {
    const parsed = new URL(url);
    last = parsed.pathname.split('/').filter(Boolean).pop() ?? url;
  } catch {
    last = url.split('/').filter(Boolean).pop() ?? url;
  }
  return stripArchiveExt(last);
}

/** True if `p` exists (any type). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move `src` → `dest`, falling back to a recursive copy + remove on `EXDEV`
 * (cross-device rename, e.g. the OS temp dir and the data dir on different
 * filesystems).
 */
async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
