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
 * Scope note: like iOS Task 2, this task does not port MC's edit-diff
 * auto-open, directory-listing/numbered-source result detection, or
 * TodoWrite checklist body — those are out of scope per the design doc's
 * "Out of scope" section and the iOS precedent (see task-2 progress notes).
 * `summarize()` still special-cases TodoWrite's "{done}/{total} done" header
 * text (that's cheap and highly legible), but the expanded body for a
 * TodoWrite tool falls through to the generic details + result rendering,
 * same as any other tool.
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
  return TOOL_LABELS[n] ?? name.charAt(0).toUpperCase() + name.slice(1);
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

/** Truncate `s` to `max` characters. For strings containing "/", uses a
 * middle-ellipsis that preserves the trailing filename. */
export function middleTruncate(s: string, max = 60): string {
  if (s.length <= max) return s;

  if (s.includes('/')) {
    const lastSlash = s.lastIndexOf('/');
    const filename = s.slice(lastSlash); // includes the leading /
    const prefix = s.slice(0, max - filename.length - 1);
    if (prefix.length > 3) {
      return `${prefix}…${filename}`;
    }
  }

  return `${s.slice(0, max)}…`;
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

  const keys = PRIMARY_KEYS[normalizeTool(name)] ?? [];
  for (const key of keys) {
    const val = input[key];
    if (typeof val === 'string' && val) return middleTruncate(val);
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
export function formatDetails(input: Record<string, unknown> | undefined): ToolDetail[] {
  if (!input) return [];
  return Object.entries(input).map(([key, val]) => {
    if (typeof val === 'string') {
      if (val.length > 80) return { key, value: `"${val.slice(0, 80)}…" (${val.length} chars)` };
      return { key, value: val };
    }
    if (Array.isArray(val)) return { key, value: `[${val.length} items]` };
    if (typeof val === 'object' && val !== null) return { key, value: '{object}' };
    return { key, value: String(val) };
  });
}

const READ_SKIP_KEYS = new Set(['path', 'offset', 'limit']);
const WRITE_SKIP_KEYS = new Set(['content']);

/** `formatDetails`, filtered per-tool the way MC's ToolBlock call site does:
 * read hides path/offset/limit (already in the summary), write hides
 * content (too large for a key/value line — a future task may add a rich
 * preview, out of scope here per the design doc). */
export function formatVisibleDetails(
  name: string,
  input: Record<string, unknown> | undefined,
): ToolDetail[] {
  const all = formatDetails(input);
  const normalized = normalizeTool(name);
  if (normalized === 'read') return all.filter(({ key }) => !READ_SKIP_KEYS.has(key));
  if (normalized === 'write') return all.filter(({ key }) => !WRITE_SKIP_KEYS.has(key));
  return all;
}
