import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PluginScanLevel = 'safe' | 'suspicious' | 'dangerous';

export interface PluginScanVerdict {
  verdict: PluginScanLevel;
  reasons: string[];
}

/** Minimal sink for non-fatal scan notices (a missing/unreadable/malformed payload). */
interface ScanLogger {
  warn(msg: string): void;
}

const LEVEL_ORDER: Record<PluginScanLevel, number> = { safe: 0, suspicious: 1, dangerous: 2 };

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Keys that signal a prototype-pollution attempt when present in parsed JSON. */
const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];

// --- Ported verbatim from packages/agent/src/skills/security.ts ----------------
// `@dash/plugins` must NOT depend on `@dash/agent`, so the pattern lists are
// duplicated here (small static-data copy, deliberate trade-off vs. a backwards
// dependency). Keep these in sync with the skill scanner.

const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/i,
    reason: 'pipes a download straight into a shell',
  },
  { re: /\brm\s+-rf\s+[~/]/i, reason: 'destructive recursive delete of a root or home path' },
  {
    re: /ignore\s+(all\s+|any\s+)?(your\s+|the\s+|these\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|messages?)/i,
    reason: 'prompt-injection: tries to override prior instructions',
  },
  {
    re: /\b(send|exfiltrate|upload|post|leak|forward)\b[^\n]{0,60}\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|credentials?|env(ironment)?\s+variables?)\b/i,
    reason: 'attempts to exfiltrate secrets or credentials',
  },
  { re: /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/, reason: 'embeds a private key' },
];

const SUSPICIOUS_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /\bbase64\b\s+(--decode|-d)\b|\batob\s*\(/i,
    reason: 'decodes base64 (possible obfuscation)',
  },
  { re: /\b(printenv|process\.env|cat\s+[^\n]*\.env\b)/i, reason: 'reads environment variables' },
];

// -----------------------------------------------------------------------------

/**
 * Deterministic, dependency-free prefilter over arbitrary text (a bin script, a
 * hook command, an MCP command string). Returns the strictest level any pattern
 * hits plus a reason per match. Never throws.
 */
export function scanText(content: string): PluginScanVerdict {
  const reasons: string[] = [];
  let verdict: PluginScanLevel = 'safe';

  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(content)) {
      reasons.push(reason);
      verdict = 'dangerous';
    }
  }
  if (verdict !== 'dangerous') {
    for (const { re, reason } of SUSPICIOUS_PATTERNS) {
      if (re.test(content)) {
        reasons.push(reason);
        verdict = 'suspicious';
      }
    }
  }
  return { verdict, reasons };
}

/**
 * Heuristic, fail-closed security scan of an on-disk plugin directory. Reads the
 * plugin's executable/config payloads and classifies them as `safe`,
 * `suspicious`, or `dangerous`:
 *
 * 1. `.claude-plugin/plugin.json` — re-checks the `name` is kebab-case. A bad
 *    name is recorded as a reason but is NEVER on its own `dangerous`.
 * 2. `bin/*` — EVERY file's text is scanned with {@link scanText} (shebang or
 *    not — a dangerous payload need not declare `#!` to run); a dangerous
 *    pattern (curl|sh, `rm -rf ~/`, ...) → dangerous, env-read / base64 →
 *    suspicious.
 * 3. `hooks/hooks.json` — parsed; a `__proto__`/`constructor`/`prototype` own
 *    key is flagged as a pollution attempt (suspicious); every string value is
 *    scanned with {@link scanText} (so hook command/shell strings are checked).
 * 4. `.mcp.json` — parsed; must be a plain object (pollution keys → suspicious);
 *    every string value (command, args, ...) is scanned with {@link scanText}.
 * 5. `providers/*.json` — parsed; must be a plain object (pollution keys →
 *    suspicious). Providers are DATA-ONLY: no shell/command scanning.
 *
 * Severity choice: a prototype-pollution key in a config is treated as
 * `suspicious` (a structural red flag worth surfacing, but not a confirmed
 * destructive action on its own).
 *
 * Never throws for content reasons. Filesystem errors (missing dir/file,
 * unreadable) and malformed JSON are caught, optionally `logger?.warn(...)`-ed,
 * and treated as `safe` for that payload (no readable payload = no detectable
 * danger). A missing `pluginDir` is `safe`.
 */
export async function heuristicPluginScan(
  pluginDir: string,
  logger?: ScanLogger,
): Promise<PluginScanVerdict> {
  const reasons: string[] = [];
  let verdict: PluginScanLevel = 'safe';

  const escalate = (v: PluginScanVerdict): void => {
    for (const r of v.reasons) reasons.push(r);
    if (LEVEL_ORDER[v.verdict] > LEVEL_ORDER[verdict]) verdict = v.verdict;
  };

  if (!pluginDir || !existsSync(pluginDir)) {
    return { verdict, reasons };
  }

  escalate(await scanManifest(pluginDir, logger));
  escalate(await scanBinDir(pluginDir, logger));
  escalate(await scanHooks(pluginDir, logger));
  escalate(await scanMcp(pluginDir, logger));
  escalate(await scanProviders(pluginDir, logger));

  return { verdict, reasons };
}

/** Re-validates the manifest `name` is kebab-case. A bad name is a note only. */
async function scanManifest(pluginDir: string, logger?: ScanLogger): Promise<PluginScanVerdict> {
  const path = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!existsSync(path)) return { verdict: 'safe', reasons: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    logger?.warn(`plugin scan: unreadable/malformed manifest at ${path}: ${errMsg(err)}`);
    return { verdict: 'safe', reasons: [] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { verdict: 'safe', reasons: [] };
  }
  const name = (raw as Record<string, unknown>).name;
  if (typeof name === 'string' && name.length > 0 && !KEBAB_CASE.test(name)) {
    // A bad name is recorded but never escalates severity.
    return { verdict: 'safe', reasons: [`manifest 'name' is not kebab-case: '${name}'`] };
  }
  return { verdict: 'safe', reasons: [] };
}

/** Scans every file directly under `bin/` (shebang or not — see note below). */
async function scanBinDir(pluginDir: string, logger?: ScanLogger): Promise<PluginScanVerdict> {
  const binDir = join(pluginDir, 'bin');
  let entries: Dirent[];
  try {
    if (!statSync(binDir).isDirectory()) return { verdict: 'safe', reasons: [] };
    entries = readdirSync(binDir, { withFileTypes: true });
  } catch {
    return { verdict: 'safe', reasons: [] };
  }
  const reasons: string[] = [];
  let verdict: PluginScanLevel = 'safe';
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(binDir, entry.name);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (err) {
      logger?.warn(`plugin scan: unreadable bin file ${path}: ${errMsg(err)}`);
      continue;
    }
    // Scan EVERY bin file's text, shebang or not. A dangerous payload need not
    // declare a shebang to run (e.g. `bin/install.js` invoked via `node`, or a
    // file run by a parent wrapper), so gating on `#!` would be a false-negative
    // hole in a security control. The text patterns are shell/JS-oriented and
    // inert on genuine data files.
    const v = scanText(content);
    for (const r of v.reasons) reasons.push(`bin/${entry.name}: ${r}`);
    if (LEVEL_ORDER[v.verdict] > LEVEL_ORDER[verdict]) verdict = v.verdict;
  }
  return { verdict, reasons };
}

/** Parses `hooks/hooks.json`, flags pollution keys, scans all string values. */
async function scanHooks(pluginDir: string, logger?: ScanLogger): Promise<PluginScanVerdict> {
  return scanJsonPayload(join(pluginDir, 'hooks', 'hooks.json'), 'hooks.json', logger, true);
}

/** Parses `.mcp.json`, flags pollution keys, scans all string values. */
async function scanMcp(pluginDir: string, logger?: ScanLogger): Promise<PluginScanVerdict> {
  return scanJsonPayload(join(pluginDir, '.mcp.json'), '.mcp.json', logger, true);
}

/** Parses each `providers/*.json`, flags pollution keys. Data-only: no text scan. */
async function scanProviders(pluginDir: string, logger?: ScanLogger): Promise<PluginScanVerdict> {
  const providersDir = join(pluginDir, 'providers');
  let entries: Dirent[];
  try {
    if (!statSync(providersDir).isDirectory()) return { verdict: 'safe', reasons: [] };
    entries = readdirSync(providersDir, { withFileTypes: true });
  } catch {
    return { verdict: 'safe', reasons: [] };
  }
  const reasons: string[] = [];
  let verdict: PluginScanLevel = 'safe';
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const v = await scanJsonPayload(
      join(providersDir, entry.name),
      `providers/${entry.name}`,
      logger,
      false,
    );
    for (const r of v.reasons) reasons.push(r);
    if (LEVEL_ORDER[v.verdict] > LEVEL_ORDER[verdict]) verdict = v.verdict;
  }
  return { verdict, reasons };
}

/**
 * Reads + parses a JSON file. Flags prototype-pollution keys (suspicious). When
 * `scanValues` is true, runs {@link scanText} over every nested string value.
 * Filesystem errors / malformed JSON → `safe` for that payload (+ warn).
 */
async function scanJsonPayload(
  path: string,
  label: string,
  logger: ScanLogger | undefined,
  scanValues: boolean,
): Promise<PluginScanVerdict> {
  if (!existsSync(path)) return { verdict: 'safe', reasons: [] };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    logger?.warn(`plugin scan: unreadable ${label} at ${path}: ${errMsg(err)}`);
    return { verdict: 'safe', reasons: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger?.warn(`plugin scan: malformed JSON in ${label} at ${path}: ${errMsg(err)}`);
    return { verdict: 'safe', reasons: [] };
  }

  const reasons: string[] = [];
  let verdict: PluginScanLevel = 'safe';

  // Raw-text pollution-key check: JSON.parse drops a literal "__proto__" key
  // from the resulting object (it never becomes an own property), so a structural
  // walk would miss it. A textual scan of the source catches all three keys.
  if (hasPollutionKey(text)) {
    reasons.push(`${label}: prototype-pollution attempt (forbidden key)`);
    verdict = 'suspicious';
  }

  if (scanValues) {
    for (const value of collectStrings(parsed)) {
      const v = scanText(value);
      for (const r of v.reasons) reasons.push(`${label}: ${r}`);
      if (LEVEL_ORDER[v.verdict] > LEVEL_ORDER[verdict]) verdict = v.verdict;
    }
  }
  return { verdict, reasons };
}

/** True if the raw JSON text declares a forbidden pollution key. */
function hasPollutionKey(text: string): boolean {
  return POLLUTION_KEYS.some((k) => new RegExp(`"${k}"\\s*:`).test(text));
}

/** Depth-first collection of every string in a parsed JSON value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
