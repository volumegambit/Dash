/** Normalize legacy tool names (read_file, write_file, etc.) to canonical names */
function normalizeTool(name: string): string {
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
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Check if tool name is TodoWrite */
export function isTodoWrite(name: string): boolean {
  const n = normalizeTool(name);
  return n === 'task' || n === 'todowrite';
}

/** Parse TodoWrite input JSON into structured todo items, or null if parsing fails */
export function parseTodos(input: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const todos = parsed.todos;
    if (!Array.isArray(todos) || todos.length === 0) return null;
    return todos.filter(
      (t): t is TodoItem =>
        typeof t === 'object' && t !== null && typeof (t as TodoItem).content === 'string',
    );
  } catch {
    return null;
  }
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

/** Return a human-friendly label for a tool name */
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
export function truncate(s: string, max = 60): string {
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

export function summarize(name: string, input: string): string {
  if (!input) return '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return '';
  }

  // Custom summary for TodoWrite: show completion count
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
    const val = parsed[key];
    // Shorten BEFORE truncating: otherwise `/opt/homebrew/bin/` spends 18 of
    // the 60-character budget before the command even starts.
    if (typeof val === 'string' && val) {
      return truncate(normalized === 'bash' ? shortenCommand(val) : val);
    }
  }

  // Fallback: first string value in the object
  for (const val of Object.values(parsed)) {
    if (typeof val === 'string' && val) return truncate(val);
  }

  return '';
}

export function formatDetails(input: string): { key: string; value: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [{ key: 'input', value: input }];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [{ key: 'input', value: input }];
  }

  return Object.entries(parsed as Record<string, unknown>).map(([key, val]) => {
    if (typeof val === 'string') {
      if (val.length > 80) return { key, value: `"${val.slice(0, 80)}…" (${val.length} chars)` };
      return { key, value: val };
    }
    if (Array.isArray(val)) return { key, value: `[${val.length} items]` };
    if (typeof val === 'object' && val !== null) return { key, value: '{object}' };
    return { key, value: String(val) };
  });
}

/**
 * Splices a newline into `value` at the caret/selection, returning the new
 * value and where the caret should land.
 *
 * Deliberately duplicated in the web app's `ui/composer.ts`: the two apps
 * share no UI package, and a cross-package dependency for eight lines of
 * index arithmetic would cost more than the duplication does. If a third
 * consumer appears, that is the moment to extract it.
 */
export function insertNewlineAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const max = value.length;
  const rawStart = Number.isFinite(selectionStart) ? selectionStart : max;
  const rawEnd = Number.isFinite(selectionEnd) ? selectionEnd : max;
  const a = Math.min(Math.max(rawStart, 0), max);
  const b = Math.min(Math.max(rawEnd, 0), max);
  const start = Math.min(a, b);
  const end = Math.max(a, b);

  return {
    value: `${value.slice(0, start)}\n${value.slice(end)}`,
    caret: start + 1,
  };
}
