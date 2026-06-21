import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_MARKETPLACE_BYTES, fetchTextCapped } from './fetch.js';
import { gitCloneToTemp } from './git.js';
import { PluginOpError, defaultGitRemote, parsePluginSource } from './install.js';
import { realpathContained } from './manifest.js';

/**
 * One plugin advertised by a marketplace. `source` is what a caller passes to
 * `installPluginToDir` (a `git:`/`http(s):` URL or a local path).
 */
export interface MarketplaceEntry {
  name: string;
  source: string;
  description?: string;
  author?: string;
  version?: string;
}

/** A marketplace manifest: metadata plus the list of advertised plugins. */
export interface MarketplaceConfig {
  name?: string;
  owner?: string;
  description?: string;
  plugins: MarketplaceEntry[];
}

const MARKETPLACE_FILE = 'marketplace.json';

/**
 * Read and validate a marketplace manifest from `source`.
 *
 * `source` is resolved the same way plugin install sources are
 * ({@link parsePluginSource}):
 * - **local**: a directory → `<dir>/marketplace.json`; a `.json` file → read
 *   directly; any other existing file → read as JSON.
 * - **url**: the URL points AT the `marketplace.json` document; it is fetched.
 * - **git**: the repo is shallow-cloned into a temp dir (depth-1 with a SHA
 *   fallback, same as install) and `<clone>/<subpath?>/marketplace.json` is read.
 *   A `git:` source may be a GitHub `owner/repo[/subpath][@ref]` shorthand OR a
 *   direct git remote (a local path / URL), with an optional `#<subpath>`.
 *
 * Missing file / failed fetch / failed clone → `PluginOpError('not_found')`.
 * Malformed JSON, a non-object top level, a non-array `plugins`, or an entry
 * lacking a string `name`/`source` → `PluginOpError('invalid_manifest')`.
 *
 * The returned config is reconstructed field-by-field from validated values —
 * the untrusted JSON is never spread, and `__proto__`/`constructor`/`prototype`
 * keys are never copied, so a crafted manifest cannot pollute prototypes.
 */
export async function readMarketplace(source: string): Promise<MarketplaceConfig> {
  const parsed = parsePluginSource(source);

  if (parsed.kind === 'url') {
    return parseMarketplaceJson(await fetchMarketplaceText(parsed.url));
  }

  if (parsed.kind === 'git') {
    return readMarketplaceFromGit(source, parsed.owner, parsed.repo, parsed.subpath, parsed.ref);
  }

  // local
  return parseMarketplaceJson(await readLocalMarketplaceText(parsed.path));
}

/**
 * Load the marketplace at `marketplaceSource` and return the entry named
 * `entryName`. Throws `PluginOpError('not_found')` when no entry matches (errors
 * from {@link readMarketplace} propagate unchanged).
 */
export async function resolveMarketplacePlugin(
  marketplaceSource: string,
  entryName: string,
): Promise<MarketplaceEntry> {
  const config = await readMarketplace(marketplaceSource);
  const entry = config.plugins.find((p) => p.name === entryName);
  if (!entry) {
    throw new PluginOpError(
      'not_found',
      `plugin '${entryName}' not found in marketplace '${marketplaceSource}'`,
    );
  }
  return entry;
}

// --- source readers ----------------------------------------------------------

/** Expand a leading `~/` to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** Read the marketplace document text from a local directory or file. */
async function readLocalMarketplaceText(path: string): Promise<string> {
  const expanded = expandHome(path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(expanded);
  } catch {
    throw new PluginOpError('not_found', `marketplace source not found: ${expanded}`);
  }
  const file = info.isDirectory() ? join(expanded, MARKETPLACE_FILE) : expanded;
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new PluginOpError('not_found', `marketplace manifest not found: ${file}`);
  }
}

/**
 * Fetch the marketplace document text from a URL with an abort timeout AND a
 * size cap (I2): a hung remote is aborted; a body larger than
 * {@link MAX_MARKETPLACE_BYTES} is rejected. Failures → `not_found`/`corrupt_archive`.
 */
async function fetchMarketplaceText(url: string): Promise<string> {
  return fetchTextCapped(url, MAX_MARKETPLACE_BYTES, 'marketplace');
}

/**
 * Clone a git source into a temp dir and read its marketplace manifest.
 *
 * The raw `git:` source decides the remote: if its remainder (after `git:` and
 * an optional `#subpath`) looks like a direct remote (a path or URL), it is
 * cloned verbatim and `#subpath` selects the directory; otherwise it is treated
 * as a GitHub `owner/repo` shorthand and the parsed `subpath`/`ref` apply.
 */
async function readMarketplaceFromGit(
  rawSource: string,
  owner: string,
  repo: string,
  parsedSubpath: string | undefined,
  ref: string | undefined,
): Promise<MarketplaceConfig> {
  const resolved = resolveGitRemote(rawSource, owner, repo);
  // For a GitHub shorthand the parsed subpath/ref apply; a direct remote ignores
  // them (parse's owner/repo/subpath split is meaningless for a raw path/URL).
  const effectiveSubpath = resolved.direct ? resolved.subpath : parsedSubpath;
  const effectiveRef = resolved.direct ? undefined : ref;
  const remote = resolved.remote;

  let cloned: Awaited<ReturnType<typeof gitCloneToTemp>>;
  try {
    cloned = await gitCloneToTemp(remote, effectiveRef, 'dash-marketplace-git-');
  } catch (err) {
    throw new PluginOpError('not_found', `failed to clone marketplace ${remote}: ${errMsg(err)}`);
  }
  try {
    const dir = effectiveSubpath ? join(cloned.dir, effectiveSubpath) : cloned.dir;
    // C1 (security): a `#subpath` on a direct remote bypasses `parsePluginSource`
    // (it is split off the raw source here), so guard the join: the resolved dir
    // must stay inside the clone (realpath-resolved). A `../escape` reads an
    // arbitrary host marketplace.json otherwise.
    if (effectiveSubpath && !realpathContained(cloned.dir, dir)) {
      throw new PluginOpError(
        'not_found',
        `marketplace subpath '${effectiveSubpath}' escapes the cloned repository`,
      );
    }
    const file = join(dir, MARKETPLACE_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      throw new PluginOpError('not_found', `marketplace manifest not found in repo: ${file}`);
    }
    return parseMarketplaceJson(text);
  } finally {
    await cloned.cleanup();
  }
}

/**
 * Resolve a `git:` source's remote. A direct remote (local path / URL / scp
 * form) is cloned verbatim with an optional trailing `#<subpath>`; everything
 * else is a GitHub `owner/repo` shorthand.
 */
function resolveGitRemote(
  rawSource: string,
  owner: string,
  repo: string,
): { remote: string; direct: boolean; subpath?: string } {
  const afterScheme = rawSource.trim().slice('git:'.length);
  const hash = afterScheme.indexOf('#');
  const remoteCandidate = hash >= 0 ? afterScheme.slice(0, hash) : afterScheme;
  const subpath = hash >= 0 ? afterScheme.slice(hash + 1) || undefined : undefined;

  if (isDirectGitRemote(remoteCandidate)) {
    return { remote: remoteCandidate, direct: true, subpath };
  }
  return { remote: defaultGitRemote(owner, repo), direct: false };
}

/**
 * True when a `git:` remainder is a concrete remote rather than `owner/repo`
 * shorthand: an absolute/home/relative path, a `file:`/`http(s):`/`ssh:` URL, or
 * an scp-style `git@host:…` address.
 */
function isDirectGitRemote(s: string): boolean {
  return (
    s.startsWith('/') ||
    s.startsWith('~') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('file:') ||
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('ssh://') ||
    s.startsWith('git://') ||
    /^[^/]+@[^/]+:/.test(s) ||
    /^[a-zA-Z]:[\\/]/.test(s)
  );
}

// --- parse + validate (proto-pollution safe) ---------------------------------

/** Keys never copied from untrusted JSON, to prevent prototype pollution. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse + validate a marketplace JSON document, reconstructing a clean
 * {@link MarketplaceConfig}. Throws `PluginOpError('invalid_manifest')` for
 * malformed JSON or an invalid structure.
 */
function parseMarketplaceJson(text: string): MarketplaceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PluginOpError('invalid_manifest', `invalid marketplace JSON: ${errMsg(err)}`);
  }

  if (!isPlainObject(raw)) {
    throw new PluginOpError('invalid_manifest', 'marketplace manifest must be a JSON object');
  }
  const pluginsRaw = readOwn(raw, 'plugins');
  if (!Array.isArray(pluginsRaw)) {
    throw new PluginOpError('invalid_manifest', 'marketplace manifest must have a `plugins` array');
  }

  const config: MarketplaceConfig = { plugins: [] };
  assignOptionalString(config, 'name', readOwn(raw, 'name'));
  assignOptionalString(config, 'owner', readOwn(raw, 'owner'));
  assignOptionalString(config, 'description', readOwn(raw, 'description'));

  config.plugins = pluginsRaw.map((entry, i) => reconstructEntry(entry, i));
  return config;
}

/** Build a clean {@link MarketplaceEntry} from one validated raw entry. */
function reconstructEntry(entry: unknown, index: number): MarketplaceEntry {
  if (!isPlainObject(entry)) {
    throw new PluginOpError('invalid_manifest', `marketplace entry ${index} must be an object`);
  }
  const name = readOwn(entry, 'name');
  const source = readOwn(entry, 'source');
  if (typeof name !== 'string' || name.length === 0) {
    throw new PluginOpError('invalid_manifest', `marketplace entry ${index} is missing a name`);
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new PluginOpError('invalid_manifest', `marketplace entry '${name}' is missing a source`);
  }
  const result: MarketplaceEntry = { name, source };
  assignOptionalString(result, 'description', readOwn(entry, 'description'));
  assignOptionalString(result, 'author', readOwn(entry, 'author'));
  assignOptionalString(result, 'version', readOwn(entry, 'version'));
  return result;
}

/**
 * Read an OWN property by key, skipping the dangerous prototype keys. Returns
 * `undefined` for forbidden or absent keys so they are never reflected onto the
 * reconstructed object.
 */
function readOwn(obj: Record<string, unknown>, key: string): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return obj[key];
}

/** Set `target[key]` to `value` only when it is a string. */
function assignOptionalString<K extends string, T extends Partial<Record<K, string>>>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (typeof value === 'string') {
    target[key] = value as T[K];
  }
}

/** True for a non-null, non-array plain object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
