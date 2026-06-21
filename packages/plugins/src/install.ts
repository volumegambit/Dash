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
