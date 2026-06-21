import { describe, expect, it } from 'vitest';
import { filterPluginsByAgent } from './plugin-filtering.js';

// Shared fixtures: two plugins (alpha, beta) each contributing skill dirs +
// command files, plus a flat aggregate that mirrors wiringState.skillDirs.
const ALPHA_SKILLS = ['/plugins/alpha/skills'];
const BETA_SKILLS = ['/plugins/beta/skills/one', '/plugins/beta/skills/two'];
const ALL_SKILL_DIRS = [...ALPHA_SKILLS, ...BETA_SKILLS];
const SKILL_DIRS_BY_PLUGIN: Record<string, string[]> = {
  alpha: ALPHA_SKILLS,
  beta: BETA_SKILLS,
};
const ALL_COMMAND_FILES = [
  { file: '/plugins/alpha/commands/go.md', namespace: 'alpha' },
  { file: '/plugins/alpha/agents/helper.md', namespace: 'alpha' },
  { file: '/plugins/beta/commands/build.md', namespace: 'beta' },
];

describe('filterPluginsByAgent', () => {
  it('undefined → returns ALL skill dirs and command files (backward compat)', () => {
    const result = filterPluginsByAgent(
      undefined,
      ALL_SKILL_DIRS,
      ALL_COMMAND_FILES,
      SKILL_DIRS_BY_PLUGIN,
    );
    // Same contents — backward compat: no per-agent selection means "all".
    expect(result.skillDirs).toEqual(ALL_SKILL_DIRS);
    expect(result.commandFiles).toEqual(ALL_COMMAND_FILES);
  });

  it("['alpha'] → only alpha's skill dirs and alpha command files", () => {
    const result = filterPluginsByAgent(
      ['alpha'],
      ALL_SKILL_DIRS,
      ALL_COMMAND_FILES,
      SKILL_DIRS_BY_PLUGIN,
    );
    expect(result.skillDirs).toEqual(ALPHA_SKILLS);
    expect(result.commandFiles).toEqual([
      { file: '/plugins/alpha/commands/go.md', namespace: 'alpha' },
      { file: '/plugins/alpha/agents/helper.md', namespace: 'alpha' },
    ]);
  });

  it("['beta'] → only beta's (multi-dir) skill dirs and beta command files", () => {
    const result = filterPluginsByAgent(
      ['beta'],
      ALL_SKILL_DIRS,
      ALL_COMMAND_FILES,
      SKILL_DIRS_BY_PLUGIN,
    );
    expect(result.skillDirs).toEqual(BETA_SKILLS);
    expect(result.commandFiles).toEqual([
      { file: '/plugins/beta/commands/build.md', namespace: 'beta' },
    ]);
  });

  it('multiple selected plugins union their contributions, preserving allSkillDirs order', () => {
    const result = filterPluginsByAgent(
      ['beta', 'alpha'], // selection order does NOT change skillDirs order
      ALL_SKILL_DIRS,
      ALL_COMMAND_FILES,
      SKILL_DIRS_BY_PLUGIN,
    );
    // skillDirs order follows the flat aggregate, not the selection order.
    expect(result.skillDirs).toEqual(ALL_SKILL_DIRS);
    expect(result.commandFiles).toEqual(ALL_COMMAND_FILES);
  });

  it('an unknown (not-loaded) plugin name contributes nothing and does not throw', () => {
    const result = filterPluginsByAgent(
      ['alpha', 'ghost'], // 'ghost' is not in skillDirsByPlugin / commandFiles
      ALL_SKILL_DIRS,
      ALL_COMMAND_FILES,
      SKILL_DIRS_BY_PLUGIN,
    );
    expect(result.skillDirs).toEqual(ALPHA_SKILLS);
    expect(result.commandFiles).toEqual([
      { file: '/plugins/alpha/commands/go.md', namespace: 'alpha' },
      { file: '/plugins/alpha/agents/helper.md', namespace: 'alpha' },
    ]);
  });

  it('empty [] → empty contributions (literal "none"; MC maps empty→undefined upstream)', () => {
    const result = filterPluginsByAgent(
      [],
      ALL_SKILL_DIRS,
      ALL_COMMAND_FILES,
      SKILL_DIRS_BY_PLUGIN,
    );
    expect(result.skillDirs).toEqual([]);
    expect(result.commandFiles).toEqual([]);
  });

  it('dedups skill dirs shared by two selected plugins, preserving first occurrence', () => {
    const shared = '/plugins/shared/skills';
    const allSkillDirs = [shared, '/plugins/alpha/only'];
    const byPlugin: Record<string, string[]> = {
      alpha: [shared, '/plugins/alpha/only'],
      beta: [shared],
    };
    const result = filterPluginsByAgent(['alpha', 'beta'], allSkillDirs, [], byPlugin);
    expect(result.skillDirs).toEqual([shared, '/plugins/alpha/only']);
  });

  it('only returns skill dirs that exist in the flat aggregate (membership is intersection)', () => {
    // skillDirsByPlugin may name a dir the flat aggregate filtered out (e.g.
    // a duplicate dropped upstream). Only dirs present in allSkillDirs survive.
    const byPlugin: Record<string, string[]> = {
      alpha: ['/plugins/alpha/skills', '/plugins/alpha/dropped'],
    };
    const result = filterPluginsByAgent(['alpha'], ['/plugins/alpha/skills'], [], byPlugin);
    expect(result.skillDirs).toEqual(['/plugins/alpha/skills']);
  });
});
