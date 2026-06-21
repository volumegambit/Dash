import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseFrontmatterFields } from './frontmatter.js';
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
    // Parse frontmatter fields WITHOUT requiring `name`: Claude Code command
    // files commonly carry `description:` but no `name:` (name defaults to the
    // filename). We still want to keep their description.
    const parsed = parseFrontmatterFields(raw);
    const fmName = parsed && typeof parsed.fields.name === 'string' ? parsed.fields.name : '';
    const name = fmName || basename(file).replace(/\.md$/, '');
    const description =
      parsed && typeof parsed.fields.description === 'string' ? parsed.fields.description : '';
    const content = parsed?.content ?? raw;
    out.push({ name, description, location: file, content, editable: false, source: 'agent' });
  }
  return out;
}
