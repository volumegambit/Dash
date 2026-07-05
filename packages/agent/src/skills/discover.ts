import { homedir } from 'node:os';
import { scanSkillsDirectory } from './scanner.js';
import type { SkillDiscoveryResult } from './types.js';

export interface DiscoverSkillsOptions {
  /** Per-agent managed skills directory (highest precedence). */
  managedSkillsDir?: string;
  /** Additional skill directories from agent config. */
  paths?: string[];
}

/**
 * Discover skills across all tiers in precedence order (first wins by name):
 * 1. managed directory, 2. configured paths.
 *
 * Plugin skill directories (including the built-in plugins) arrive via `paths`
 * from the gateway. A per-agent skill therefore shadows a configured-path skill
 * of the same name.
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

  return results;
}
