import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { SkillDiscoveryResult } from './types.js';

/**
 * Scan a directory for SKILL.md files in subdirectories.
 * Each subdirectory is treated as a potential skill.
 */
export async function scanSkillsDirectory(
  dirPath: string,
  defaultSource: 'managed' | 'agent' | 'remote',
): Promise<SkillDiscoveryResult[]> {
  if (!existsSync(dirPath)) return [];

  const entries = await readdir(dirPath, { withFileTypes: true });
  const results: SkillDiscoveryResult[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFile = join(dirPath, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    try {
      const raw = await readFile(skillFile, 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      // Check for .source marker file
      let source = defaultSource;
      const sourceMarker = join(dirPath, entry.name, '.source');
      if (existsSync(sourceMarker)) {
        try {
          const markerContent = (await readFile(sourceMarker, 'utf-8')).trim();
          if (markerContent === 'agent') source = 'agent';
        } catch {
          // Ignore unreadable marker
        }
      }

      results.push({
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        trigger: parsed.frontmatter.trigger,
        location: skillFile,
        content: parsed.content,
        editable: true,
        source,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}
