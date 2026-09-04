import { MEMORY_LIMITS, MEMORY_TYPES, type MemoryInfo, type MemoryType } from './types.js';

const HEADING = '# Memory index';
const GROUP_TITLE: Record<MemoryType, string> = {
  user: 'User',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
};

/**
 * Render MEMORY.md: one line per memory, grouped by type. Never contains
 * memory bodies — the index is pointers only. When the output would exceed
 * `maxChars`, trailing lines are dropped and a final "…and N more" line is
 * appended so the model knows to use recall_memory.
 */
export function renderIndex(memories: MemoryInfo[], opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? MEMORY_LIMITS.indexMaxChars;
  if (memories.length === 0) return `${HEADING}\n\n_No memories yet._\n`;

  const lines: string[] = [HEADING, ''];
  for (const type of MEMORY_TYPES) {
    const group = memories.filter((m) => m.type === type);
    if (group.length === 0) continue;
    lines.push(`## ${GROUP_TITLE[type]}`);
    for (const m of group) lines.push(`- **${m.name}** — ${m.description}`);
    lines.push('');
  }
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;

  // Drop memory lines from the end until the "and N more" footer fits.
  let dropped = 0;
  const isMemoryLine = (l: string) => l.startsWith('- **');
  const footer = (n: number) => `- …and ${n} more — use recall_memory\n`;
  const out = lines.slice();
  while (out.length > 2) {
    const candidate = `${out.join('\n')}\n${footer(dropped)}`;
    if (candidate.length <= maxChars && dropped > 0) break;
    // remove last memory line (and trailing blank/heading if the group emptied)
    let idx = out.length - 1;
    while (idx >= 0 && !isMemoryLine(out[idx])) idx--;
    if (idx < 0) break;
    out.splice(idx, 1);
    dropped++;
    // remove a heading left with no lines under it
    const next = out[idx];
    const prev = out[idx - 1];
    if (prev?.startsWith('## ') && (next === undefined || next === '' || next.startsWith('## '))) {
      out.splice(idx - 1, 1);
    }
    // collapse double blank lines
    for (let i = out.length - 1; i > 0; i--)
      if (out[i] === '' && out[i - 1] === '') out.splice(i, 1);
  }
  const body = out.join('\n').replace(/\n+$/, '');
  return `${body}\n${footer(dropped)}`;
}
