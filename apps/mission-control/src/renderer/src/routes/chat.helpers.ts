export function toolIcon(name: string): string {
  if (name === 'bash' || name === 'execute_command') return '💻';
  if (name === 'write' || name === 'write_file' || name === 'edit') return '📝';
  if (name === 'read' || name === 'read_file') return '📖';
  if (name === 'glob' || name === 'grep') return '🔍';
  if (name === 'ls' || name === 'list_directory') return '📂';
  if (name === 'web_search' || name === 'web_fetch') return '🌐';
  return '🔧';
}

const PRIMARY_KEYS: Record<string, string[]> = {
  bash: ['command'],
  execute_command: ['command'],
  write: ['path'],
  write_file: ['path'],
  edit: ['path'],
  read: ['path'],
  read_file: ['path'],
  glob: ['pattern'],
  grep: ['pattern', 'query'],
  ls: ['path', 'directory'],
  list_directory: ['path', 'directory'],
  web_search: ['query'],
  web_fetch: ['url'],
  mcp: ['tool'],
};

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function summarize(name: string, input: string): string {
  if (!input) return '';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return '';
  }

  const keys = PRIMARY_KEYS[name] ?? [];
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
