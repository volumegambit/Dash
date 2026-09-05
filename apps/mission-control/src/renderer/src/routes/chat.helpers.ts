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

export function truncate(s: string, max = 60): string {
  if (s.length <= max) return s;

  // For file paths, use middle-ellipsis to preserve the filename
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

  const keys = PRIMARY_KEYS[normalizeTool(name)] ?? [];
  for (const key of keys) {
    const val = parsed[key];
    if (typeof val === 'string' && val) return truncate(val);
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

/** What a key does in the Mission Control composer.
 *
 * A declaration, not a description: `chat.tsx`'s composer `onKeyDown` routes
 * through this, and `chat.helpers.test.ts` cross-checks every case against
 * the `mc` column of `scripts/fixtures/composer-key-contract.json` — the same
 * file the web and iOS suites check against.
 *
 * Why: Shift+Enter inserted a newline here and on web and was silently
 * impossible on iOS for months, because SwiftUI's `onSubmit` fires on every
 * Return with no modifier awareness. Every test on every client passed,
 * because each client's handler was only ever tested against itself. */
export type ComposerKeyAction = 'send' | 'newline' | 'focus';

export function composerKeyAction(
  key: string,
  shift: boolean,
  meta: boolean,
): ComposerKeyAction {
  if (key === 'Enter') return shift ? 'newline' : 'send';
  if (key === 'Tab') return shift ? 'newline' : 'focus';
  return 'focus';
}

/** How a newline arrives, for the cases that produce one.
 *
 * `handler` — this app splices the break itself.
 * `native` — the handler declines the key and the textarea inserts it.
 * Declining is exactly what iOS's `onSubmit` could not do. */
export function composerKeyMechanism(
  key: string,
  shift: boolean,
  meta: boolean,
): 'handler' | 'native' | null {
  if (composerKeyAction(key, shift, meta) !== 'newline') return null;
  return key === 'Tab' ? 'handler' : 'native';
}
