import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseFrontmatterFields } from './frontmatter.js';
import type { SkillDiscoveryResult } from './types.js';

/** A flat skill/command file to load, with an optional namespace prefix. */
export interface FlatSkillFile {
  /** Absolute path to the `.md` file. */
  file: string;
  /**
   * Optional namespace (e.g. a plugin name). When set, the derived skill name
   * is prefixed as `<namespace>:<name>` so it resolves deterministically (e.g.
   * a `/plugin:command` slash form is an exact match) and can't collide across
   * namespaces.
   */
  namespace?: string;
}

/**
 * Loads flat single-file skills/commands (Claude Code `commands/*.md`) into
 * SkillDiscoveryResult objects. Name comes from frontmatter `name`, else the
 * file basename (without `.md`); when an entry carries a `namespace`, the name
 * is prefixed as `<namespace>:<name>`. Unreadable files are skipped (never throw).
 */
export async function loadFlatSkills(files: FlatSkillFile[]): Promise<SkillDiscoveryResult[]> {
  const out: SkillDiscoveryResult[] = [];
  for (const { file, namespace } of files) {
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
    const baseName = fmName || basename(file).replace(/\.md$/, '');
    const name = namespace ? `${namespace}:${baseName}` : baseName;
    const description =
      parsed && typeof parsed.fields.description === 'string' ? parsed.fields.description : '';
    const content = parsed?.content ?? raw;
    out.push({ name, description, location: file, content, editable: false, source: 'agent' });
  }
  return out;
}
