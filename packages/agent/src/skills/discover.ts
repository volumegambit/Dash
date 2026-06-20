import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getBundledSkillsDir } from '@dash/skills';
import { scanSkillsDirectory } from './scanner.js';
import type { SkillDiscoveryResult } from './types.js';

export interface DiscoverSkillsOptions {
  /** Per-agent managed skills directory (highest precedence). */
  managedSkillsDir?: string;
  /** Additional skill directories from agent config. */
  paths?: string[];
  /** Include the bundled @dash/skills library. Defaults to true. */
  includeBundled?: boolean;
}

/**
 * Discover skills across all tiers in precedence order (first wins by name):
 * 1. managed directory, 2. configured paths, 3. bundled library.
 *
 * A per-agent skill therefore shadows a bundled skill of the same name.
 */
export async function discoverSkills(opts: DiscoverSkillsOptions): Promise<SkillDiscoveryResult[]> {
  const results: SkillDiscoveryResult[] = [];
  const seen = new Set<string>();

  const add = (skills: SkillDiscoveryResult[]): void => {
    for (const skill of skills) {
      if (!seen.has(skill.name)) {
        results.push(skill);
        seen.add(skill.name);
      }
    }
  };

  if (opts.managedSkillsDir) {
    add(await scanSkillsDirectory(opts.managedSkillsDir, 'managed'));
  }

  for (const p of opts.paths ?? []) {
    const expanded = p.startsWith('~/') ? p.replace('~', homedir()) : p;
    add(await scanSkillsDirectory(expanded, 'managed'));
  }

  if (opts.includeBundled !== false) {
    // The bundled library is organized into suite subdirectories
    // (`<root>/<suite>/<skill>/SKILL.md`), so scan each suite directory.
    const bundledRoot = getBundledSkillsDir();
    if (existsSync(bundledRoot)) {
      for (const entry of readdirSync(bundledRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          add(await scanSkillsDirectory(join(bundledRoot, entry.name), 'bundled'));
        }
      }
    }
  }

  return results;
}
