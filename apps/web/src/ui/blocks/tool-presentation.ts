/**
 * MC-parity tool-card presentation helpers — ported from Mission Control's
 * `apps/mission-control/src/renderer/src/routes/chat.helpers.ts` (design doc
 * appendix §3, BINDING). Same tables and rules as the iOS twin,
 * `ios/Dash/Features/Conversations/ToolPresentation.swift` (Task 2) — T5
 * asserts both agree against a shared fixture corpus, so this file's
 * behavior must match that Swift file's, not just MC's prose.
 *
 * Deliberate adaptation from MC's source: MC's `summarize`/`formatDetails`
 * take a raw JSON *string* (tool input as streamed) and re-`JSON.parse` it
 * internally. `ContentBlocks.tsx` already hands us the parsed
 * `Record<string, unknown>` (from the mobile contract's
 * `tool_use_start.input`), so these take that directly — one fewer
 * stringify/parse round trip, same field-selection semantics. This mirrors
 * the iOS port, which takes a parsed `JSONValue?` for the same reason.
 *
 * Unlike the iOS port, key iteration below follows MC's original
 * (`Object.entries`/`Object.values` insertion order) rather than iOS's
 * alphabetical-sort adaptation — a JS object has a real insertion order to
 * fall back on (Swift's `[String: JSONValue]` doesn't), so there's no reason
 * to diverge from MC here. (Reviewed and endorsed for iOS: sorted iteration
 * there is cosmetic, not a semantic mismatch — same reasoning holds for
 * fixtures with a single primary-key match, which is the common case.)
 *
 * Scope note: this task does not port MC's edit-diff auto-open or its
 * directory-listing/numbered-source result detection — still out of scope per
 * the design doc.
 *
 * The TodoWrite checklist body WAS in that list and no longer is: it landed
 * 2026-09-05 (UI-quality goal, Phase D) and `ContentBlocks.tsx` renders it via
 * `parseTodos`. Deferring it had left `parseTodos` here parsed, unit-tested,
 * and called by no view on web OR iOS for months, while Mission Control
 * rendered the list — a divergence no test on any client could see.
 * `summarize()` still owns the "{done}/{total} done" header text.
 */

/** Normalize legacy tool names (read_file, write_file, etc.) to canonical names. */
export function normalizeTool(name: string): string {
  switch (name) {
    case 'read_file':
      return 'read';
    case 'write_file':
      return 'write';
    case 'list_directory':
      return 'ls';
    case 'execute_command':
      return 'bash';
    case 'TodoWrite':
      return 'todowrite';
    default:
      return name;
  }
}

export interface TodoItem {
  id?: string;
  content: string;
  status: string;
}

/** True when `name` normalizes to the TodoWrite tool. */
export function isTodoWrite(name: string): boolean {
  const n = normalizeTool(name);
  return n === 'task' || n === 'todowrite';
}

/** Parse a `{ todos: [...] }` tool input into structured todo items, or null
 * when `todos` is missing, non-array, or empty. Items without a string
 * `content` field are dropped. */
export function parseTodos(input: Record<string, unknown> | undefined): TodoItem[] | null {
  if (!input) return null;
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return todos.filter(
    (t): t is TodoItem =>
      typeof t === 'object' && t !== null && typeof (t as TodoItem).content === 'string',
  );
}

const TOOL_LABELS: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  find: 'Find',
  grep: 'Grep',
  ls: 'List Directory',
  web_search: 'Web Search',
  web_fetch: 'Web Fetch',
  task: 'Task',
  load_skill: 'Load Skill',
  create_skill: 'Create Skill',
};

/** Human-friendly label for a tool name; unknown tools fall back to their
 * raw name, capitalized. */
export function toolLabel(name: string): string {
  const n = normalizeTool(name);
  return TOOL_LABELS[n] ?? humanizeToolName(name);
}

const PRIMARY_KEYS: Record<string, string[]> = {
  bash: ['command'],
  write: ['path'],
  edit: ['path'],
  read: ['path'],
  find: ['pattern'],
  grep: ['pattern', 'query'],
  ls: ['path', 'directory'],
  web_search: ['query'],
  web_fetch: ['url'],
  task: ['todos'],
  load_skill: ['name'],
  create_skill: ['name'],
};

function isPathLike(s: string): boolean {
  return s.includes('/') && !/\s/.test(s);
}

/** Truncate `s` to `max` characters. For path-like strings — containing "/"
 * and no whitespace — uses a middle-ellipsis that preserves the trailing
 * filename.
 *
 * The whitespace test is load-bearing, not a nicety. Keying the branch off
 * `includes('/')` alone, as this did until 2026-09-05, makes a shell
 * command's LAST slash — which usually sits inside a trailing argument —
 * look like a path separator. The result spliced the command's head onto
 * that argument's tail and rendered a plausible path
 * ("/opt/homebrew/bin/gog gmail li…/out.json") that never existed. A string
 * with spaces in it is a command or a sentence, not a path; plain tail
 * truncation is the honest rendering. Ported from the iOS twin, which found
 * this first. */
export function middleTruncate(s: string, max = 60): string {
  if (s.length <= max) return s;

  if (isPathLike(s)) {
    const lastSlash = s.lastIndexOf('/');
    const filename = s.slice(lastSlash); // includes the leading /
    const prefix = s.slice(0, max - filename.length - 1);
    if (prefix.length > 3) {
      return `${prefix}…${filename}`;
    }
  }

  return `${s.slice(0, max)}…`;
}

/** Drop the leading directory from a shell command's executable, so
 * `/opt/homebrew/bin/gog gmail list` summarizes as `gog gmail list`.
 *
 * A collapsed row gets roughly 40 characters on a phone. An absolute
 * launcher path spends the first ~18 of them on a prefix identical across
 * every call to the same binary, so consecutive calls are indistinguishable
 * until you expand them. The directory is not information the reader is
 * missing — it is on `$PATH` — so it goes, and the arguments that actually
 * differ move into view.
 *
 * Only the first whitespace-delimited word is touched, and only when it
 * reads as a launcher path (absolute, `./`, `../` or `~/`). Everything after
 * it is preserved byte-for-byte: `cd /Users/gerry/x && npm test` keeps its
 * path, because that path is an argument the user chose, not an install
 * location. Ported from the iOS twin. */
export function shortenCommand(command: string): string {
  const match = command.match(/^\S+/);
  if (!match) return command;
  const executable = match[0];
  if (!/^(\/|\.\/|\.\.\/|~\/)/.test(executable)) return command;
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  if (!name) return command;
  return name + command.slice(executable.length);
}

/** One-line inline summary for a tool's collapsed header, or '' when
 * there's nothing to show. */
export function summarize(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';

  if (isTodoWrite(name)) {
    const todos = parseTodos(input);
    if (todos) {
      const done = todos.filter((t) => t.status === 'completed').length;
      return `${done}/${todos.length} done`;
    }
  }

  const normalized = normalizeTool(name);
  const keys = PRIMARY_KEYS[normalized] ?? [];
  for (const key of keys) {
    const val = input[key];
    // Shorten BEFORE truncating: otherwise `/opt/homebrew/bin/` spends 18 of
    // the 60-character budget before the command even starts.
    if (typeof val === 'string' && val) {
      return middleTruncate(normalized === 'bash' ? shortenCommand(val) : val);
    }
  }

  // Fallback: first string value in the object.
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val) return middleTruncate(val);
  }

  return '';
}

export interface ToolDetail {
  key: string;
  value: string;
}

/** Key/value detail rows for a tool's expanded body. `skipKeys` (read's
 * path/offset/limit, write's content) are omitted at the call site in
 * `ContentBlocks.tsx`, mirroring where MC's ToolBlock does the filtering —
 * `formatDetails` itself, like MC's, formats every field it's given. */
export function formatDetails(
  input: Record<string, unknown> | undefined,
  keepNested = false,
): ToolDetail[] {
  if (!input) return [];
  return Object.entries(input).map(([key, val]) => {
    // For a tool this app does not know, the arguments are the only thing
    // that explains the call, so nested values render as compact JSON rather
    // than collapsing to a placeholder the filter would then drop. Without
    // this an MCP card showed `Limit: 5` and hid both `query` and `filter` —
    // the least informative field was the only one left standing.
    if (keepNested && val !== null && typeof val === 'object') {
      const json = JSON.stringify(val);
      return { key, value: json.length > 80 ? `${json.slice(0, 80)}…` : json };
    }
    if (typeof val === 'string') {
      if (val.length > 80) return { key, value: `"${val.slice(0, 80)}…" (${val.length} chars)` };
      return { key, value: val };
    }
    if (Array.isArray(val)) return { key, value: `[${val.length} items]` };
    if (typeof val === 'object' && val !== null) return { key, value: '{object}' };
    // Numbers (including integral-but-huge ones, e.g. a 20-digit tool-input
    // ID) go through native `String(val)`. Per ECMA-262 Number::toString,
    // this stays in fixed notation (plain digits, zero-padded) for any
    // magnitude below 1e21 and only switches to exponential at 1e21+ — the
    // Swift port (ToolPresentation.swift's `formatIntegralNumber`) has to
    // replicate this rule explicitly, since Swift's `String(Double)`
    // defaults to exponential notation as soon as a value leaves `Int64`
    // range. See rendering-fixtures.json's large-number `details` cases.
    return { key, value: String(val) };
  });
}

const READ_SKIP_KEYS = new Set(['path', 'offset', 'limit']);
const WRITE_SKIP_KEYS = new Set(['content']);
// `bash`: the header carries the command, shortened. The duplicate rule cannot
// drop the row because the shortened summary is not equal to the full command,
// so a card headed `Bash npm run lint` also printed
// `Command: /opt/homebrew/bin/npm run lint` directly beneath it.
const BASH_SKIP_KEYS = new Set(['command']);

const PLACEHOLDER_VALUE = /^(\{object\}|\[\d+ items?\])$/;

/** `formatDetails`, filtered down to the rows that tell the reader
 * something.
 *
 * Three rules on top of the original per-tool skips (read hides
 * path/offset/limit, write hides content — those are already shown
 * elsewhere):
 *
 * 1. A row whose value is EXACTLY the header summary is pure duplication;
 *    the header sits directly above it. Expressing this as string equality
 *    against `summarize` rather than as "drop the primary key" makes it
 *    self-correcting: a short command matches and the row goes, while a
 *    command long enough to be truncated or shortened does NOT match, so
 *    the row survives and the full value stays reachable. Nothing is ever
 *    hidden without being shown somewhere else in full.
 * 2. A row whose value is `{object}` or `[N items]` reports the input's
 *    TYPE and never its content. `Todos: [3 items]` was the agent's plan
 *    rendered as its own array length.
 * 3. Everything else stays. *
 * PARITY HAZARD, deliberately accepted: rule 1 compares against
 * `summarize`, whose LAST resort is "first string value in the object" —
 * insertion order here, sorted-key order on iOS (a Swift dictionary has no
 * insertion order to fall back on). That divergence used to be cosmetic. It
 * is now load-bearing: for a tool with no primary key and two or more string
 * inputs, the two platforms can pick different summaries and therefore drop
 * different rows. Every such tool is by definition one this repo does not
 * know, and the row is still shown on one platform and merely elided on the
 * other, so the cost is a cosmetic difference on unknown third-party tools —
 * not lost information. Fixing it properly means giving `summarize` a
 * deterministic fallback on both sides, which changes MC-parity behaviour
 * that predates this work.
 */
export function formatVisibleDetails(
  name: string,
  input: Record<string, unknown> | undefined,
): ToolDetail[] {
  const normalized = normalizeTool(name);
  const skip =
    normalized === 'read'
      ? READ_SKIP_KEYS
      : normalized === 'write'
        ? WRITE_SKIP_KEYS
        : normalized === 'bash'
          ? BASH_SKIP_KEYS
          : null;
  const summary = summarize(name, input);

  return formatDetails(input, isUnknownTool(name)).filter(({ key, value }) => {
    if (skip?.has(key)) return false;
    if (summary && value === summary) return false;
    if (PLACEHOLDER_VALUE.test(value)) return false;
    return true;
  });
}

/** Remove the chrome some tools wrap their result body in, so a line count
 * counts the body and not the envelope.
 *
 * `<path>`/`<type>` are dropped ELEMENT AND CONTENT — they are metadata the
 * collapsed header already shows, and leaving the text behind would make a
 * two-line file read as four. The remaining tags are pure wrappers, so only
 * the tags go. Mirrors Mission Control's `stripXmlTags`
 * (`components/ToolResult.tsx`), which has done this for its own rendering
 * since before the port. */
export function stripResultChrome(content: string): string {
  return content
    .replace(/<(path|type)>[\s\S]*?<\/\1>\n?/g, '')
    .replace(/<\/?(?:entries|content|results)>\n?/g, '')
    .replace(/^FilePath:.*\n?/m, '')
    .replace(/^\(\d+ entries?\)\n?/m, '')
    .trim();
}

/** Lines in `content`, ignoring leading and trailing blank lines. 0 for
 * blank input — a trailing newline is an artifact of command output, not a
 * line of it. */
export function countLines(content: string): number {
  const trimmed = content.trim();
  return trimmed ? trimmed.split('\n').length : 0;
}

function firstLine(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human byte size: `512 B`, `4.2 KB`, `1.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `+added -removed` from an edit tool's `details.diff`, or '' when there is
 * no usable diff. `+++`/`---` are unified-diff FILE HEADERS, not content, so
 * they are excluded — counting them would report every one-line edit as
 * `+2 -2`. The hyphen is ASCII U+002D, not a U+2212 minus: three platforms
 * render this string and an encoding is one more thing they could disagree
 * about. */
export function diffStat(details: unknown): string {
  if (typeof details !== 'object' || details === null) return '';
  const diff = (details as { diff?: unknown }).diff;
  if (typeof diff !== 'string' || !diff) return '';
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  if (added === 0 && removed === 0) return '';
  return `+${added} -${removed}`;
}

/** What came back, for the right edge of a collapsed tool row — the half of
 * the card `summarize` cannot answer, because `summarize` reads only the
 * tool's INPUT.
 *
 * Heuristic by necessity: the backend flattens a tool's content blocks into
 * one opaque string (`packages/agent/src/backends/piagent.ts`), so there is
 * no structured result to read. Every branch below is keyed to a shape this
 * repo's own tools actually emit — `web_search`'s numbered list comes from
 * `formatResults` in `packages/agent/src/tools/web-search.ts`, `ls`'s
 * `(N entries)` from the listing tool. The fallback is deliberately dull:
 * a third-party MCP tool's output is only reliably "some text", and
 * "N lines" is true of any text.
 *
 * Twin of `ToolPresentation.resultSummary` on iOS and of the copy in
 * Mission Control's `chat.helpers.ts`; the first two are pinned against
 * each other by `scripts/fixtures/rendering-fixtures.json`. */
export function resultSummary(
  name: string,
  content: string | undefined,
  isError = false,
  details?: unknown,
): string {
  if (content === undefined) return '';

  if (isError) {
    const line = firstLine(content);
    return line ? middleTruncate(line, 40) : 'failed';
  }

  // A task card's header already reads "2/3 done" plus the active item, and
  // its body is a rendered checklist. An outcome would be a third account of
  // the same thing.
  if (isTodoWrite(name)) return '';

  const normalized = normalizeTool(name);
  if (normalized === 'edit') return diffStat(details);

  const body = stripResultChrome(content);

  switch (normalized) {
    case 'read':
      return plural(countLines(body), 'line', 'lines');
    case 'ls': {
      // The listing tool states its own count; trust it over a line count,
      // which would also count any header or trailing note.
      const declared = content.match(/\((\d+) entries?\)/);
      const count = declared ? Number(declared[1]) : countLines(body);
      return plural(count, 'entry', 'entries');
    }
    case 'grep':
    case 'find': {
      const count = countLines(body);
      return count === 0 ? 'no matches' : plural(count, 'match', 'matches');
    }
    case 'web_search': {
      const count = (body.match(/^\d+\. \[/gm) ?? []).length;
      return count === 0 ? 'no results' : plural(count, 'result', 'results');
    }
    case 'web_fetch':
      return formatBytes(new TextEncoder().encode(body).length);
    default: {
      const count = countLines(body);
      if (count === 0) return 'no output';
      // One short line IS the outcome — "ok", "done", an exit message. Saying
      // "1 line" instead would be strictly less information for the same width.
      if (count === 1 && body.length <= 40) return body;
      return plural(count, 'line', 'lines');
    }
  }
}

/** A readable label for a tool this app does not know.
 *
 * MCP servers namespace their tools as `<server>__<tool>`, and the old
 * fallback — uppercase the first character, leave the rest — rendered
 * `linear__search_issues` as `Linear__search_issues`, which is not a thing
 * anyone can read. The server half moves to `toolNamespace`; the tool half
 * becomes title-cased words. */
export function humanizeToolName(name: string): string {
  const local = name.split('__').pop() ?? name;
  const words = local.split('_').filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The MCP server a namespaced tool belongs to, or '' for a core tool. */
export function toolNamespace(name: string): string {
  const parts = name.split('__');
  if (parts.length < 2 || !parts[0]) return '';
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
}

/** True when a body is small enough to sit inline instead of in a code block.
 *
 * Tests BOTH dimensions. The previous rule was "3 or fewer newlines", which a
 * 1.6 KB single-line page body satisfies — it then rendered with no height cap
 * and no scroll, consuming the whole viewport. */
export function fitsInline(body: string): boolean {
  return countLines(body) <= 3 && body.length <= 200;
}

/** True when a body would only repeat the header — a `load_skill`
 * confirmation under a header that already names the skill. */
export function bodyIsRedundant(name: string, content: string): boolean {
  const body = stripResultChrome(content);
  if (countLines(body) !== 1 || body.length > 80) return false;
  const n = normalizeTool(name);
  return n === 'load_skill' || n === 'create_skill';
}

/** The `content` a `write` call was asked to write. Skipped as a detail row
 * because it is too large for a key/value line, and then rendered by nothing
 * at all — a Write card showed only the tool's confirmation sentence. */
export function writtenContent(input: Record<string, unknown> | undefined): string {
  const content = input?.content;
  return typeof content === 'string' ? content : '';
}

export interface DiffLine {
  kind: 'added' | 'removed' | 'hunk' | 'context';
  text: string;
}

/** A unified diff split into typed lines, or [] when there is no diff.
 * `+++`/`---` file headers are dropped: the card header already names the
 * file, so they are two rows of noise at the top of every edit. */
export function diffLines(details: unknown): DiffLine[] {
  if (typeof details !== 'object' || details === null) return [];
  const diff = (details as { diff?: unknown }).diff;
  if (typeof diff !== 'string' || !diff) return [];
  const lines: DiffLine[] = [];
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++') || text.startsWith('---')) continue;
    if (text.startsWith('@@')) lines.push({ kind: 'hunk', text });
    else if (text.startsWith('+')) lines.push({ kind: 'added', text });
    else if (text.startsWith('-')) lines.push({ kind: 'removed', text });
    else lines.push({ kind: 'context', text });
  }
  return lines;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/** A directory listing's entries, or [] when the body does not read as one.
 * A trailing "/" marks a directory, matching what the listing tool emits and
 * what Mission Control's own `DirectoryListing` keys off. */
export function directoryEntries(content: string): DirectoryEntry[] {
  return stripResultChrome(content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name, isDirectory: name.endsWith('/') }));
}

export interface SearchResult {
  title: string;
  host: string;
}

/** Parses `web_search`'s `N. [Title](url)` list into title + host rows.
 * Returns [] when nothing matches, so an unexpected format falls through to
 * the plain body rather than rendering an empty list. */
export function searchResults(content: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^\d+\. \[(.+?)\]\((.+?)\)$/);
    if (!match) continue;
    results.push({ title: match[1], host: hostOf(match[2]) });
  }
  return results;
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return url;
  }
}

export interface GrepFileGroup {
  path: string;
  matches: { line: string; text: string }[];
}

/** Groups `path:line: text` matches by file, or [] when the body does not
 * read as grep output.
 *
 * A flat dump repeats the full path on every row, and on a phone each path
 * wraps to two lines — three matches cost eight visual lines, of which five
 * are the same repeated prefix. The path is the heading; the matches belong
 * under it. */
export function grepGroups(content: string): GrepFileGroup[] {
  const groups: GrepFileGroup[] = [];
  for (const raw of stripResultChrome(content).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(.+?):(\d+):\s?(.*)$/);
    if (!match) return [];
    const [, path, lineNumber, text] = match;
    const last = groups.at(-1);
    if (last && last.path === path) last.matches.push({ line: lineNumber, text });
    else groups.push({ path, matches: [{ line: lineNumber, text }] });
  }
  return groups;
}

/** True when this app has no built-in label for `name` — i.e. an MCP or
 * otherwise unknown tool. Such a tool's ARGUMENTS are the only thing that
 * explains the call, so `formatDetails` keeps nested values for it instead of
 * collapsing them to a `{object}` placeholder. */
export function isUnknownTool(name: string): boolean {
  return !(normalizeTool(name) in TOOL_LABELS);
}
