/** Normalize legacy tool names (read_file, write_file, etc.) to OpenCode names */
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
  priority: 'high' | 'medium' | 'low';
}

/** Check if tool name is TodoWrite */
export function isTodoWrite(name: string): boolean {
  return normalizeTool(name) === 'todowrite';
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

export function toolIcon(name: string): string {
  const n = normalizeTool(name);
  if (n === 'bash') return '💻';
  if (n === 'write' || n === 'edit') return '📝';
  if (n === 'read') return '📖';
  if (n === 'glob' || n === 'grep') return '🔍';
  if (n === 'ls') return '📂';
  if (n === 'web_search' || n === 'web_fetch') return '🌐';
  if (n === 'skill') return '⚡';
  if (n === 'mcp') return '🔌';
  if (n === 'todowrite') return '📋';
  return '🔧';
}

const PRIMARY_KEYS: Record<string, string[]> = {
  bash: ['command'],
  write: ['path'],
  edit: ['path'],
  read: ['path'],
  glob: ['pattern'],
  grep: ['pattern', 'query'],
  ls: ['path', 'directory'],
  web_search: ['query'],
  web_fetch: ['url'],
  mcp: ['tool'],
  skill: ['name'],
};

function truncate(s: string, max = 60): string {
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
  if (normalizeTool(name) === 'todowrite') {
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
