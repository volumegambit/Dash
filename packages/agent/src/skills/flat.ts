import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { SkillDiscoveryResult } from './types.js';

/**
 * Loads flat single-file skills/commands (Claude Code `commands/*.md`) into
 * SkillDiscoveryResult objects. Name comes from frontmatter `name`, else the
 * file basename (without `.md`). Unreadable files are skipped (never throw).
 */
export async function loadFlatSkills(files: string[]): Promise<SkillDiscoveryResult[]> {
  const out: SkillDiscoveryResult[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const name = parsed?.frontmatter.name || basename(file).replace(/\.md$/, '');
    const description = parsed?.frontmatter.description ?? '';
    const content = parsed?.content ?? raw;
    out.push({ name, description, location: file, content, editable: false, source: 'agent' });
  }
  return out;
}
