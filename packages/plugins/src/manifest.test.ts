import { symlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MANIFEST_DIR,
  MANIFEST_FILENAME,
  readManifest,
  resolveAgentFiles,
  resolveBinDir,
  resolveCommandFiles,
  resolveProviderFiles,
  resolveSkillDirs,
  validateManifest,
} from './manifest.js';

describe('validateManifest', () => {
  it('accepts a minimal manifest (name only) and ignores unknown fields', () => {
    const m = validateManifest({ name: 'my-plugin', futureField: 1 }, '/x/my-plugin');
    expect(m.name).toBe('my-plugin');
    expect((m as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });

  it('falls back to the directory basename when name is absent', () => {
    const m = validateManifest({ description: 'x' }, '/x/dir-name');
    expect(m.name).toBe('dir-name');
  });

  it('rejects a non-kebab-case name', () => {
    expect(() => validateManifest({ name: 'MyPlugin' }, '/x/p')).toThrow(/kebab-case/);
  });

  it('rejects non-object input', () => {
    expect(() => validateManifest([], '/x/p')).toThrow(/object/);
  });

  it('normalizes string skills to an array', () => {
    const m = validateManifest({ name: 'p', skills: './extra-skills' }, '/x/p');
    expect(m.skills).toEqual(['./extra-skills']);
  });

  it('normalizes string agents to an array', () => {
    const m = validateManifest({ name: 'p', agents: './a' }, '/x/p');
    expect(m.agents).toEqual(['./a']);
  });

  it('normalizes string providers to an array', () => {
    const m = validateManifest({ name: 'p', providers: './extra-providers' }, '/x/p');
    expect(m.providers).toEqual(['./extra-providers']);
  });

  it('drops providers when given a non-array, non-string value', () => {
    expect(validateManifest({ name: 'p', providers: 1 }, '/x/p').providers).toBeUndefined();
    expect(validateManifest({ name: 'p', providers: [1, 2] }, '/x/p').providers).toBeUndefined();
  });

  it('preserves all recognized optional fields', () => {
    const m = validateManifest(
      {
        name: 'p',
        author: { name: 'A', email: 'a@x', url: 'u' },
        homepage: 'https://h',
        repository: 'https://r',
        license: 'MIT',
        keywords: ['a', 'b'],
      },
      '/x/p',
    );
    expect(m.author).toEqual({ name: 'A', email: 'a@x', url: 'u' });
    expect(m.homepage).toBe('https://h');
    expect(m.repository).toBe('https://r');
    expect(m.license).toBe('MIT');
    expect(m.keywords).toEqual(['a', 'b']);
  });

  it('drops author when its name is not a string', () => {
    const m = validateManifest({ name: 'p', author: { name: 42 } }, '/x/p');
    expect(m.author).toBeUndefined();
  });

  it('drops keywords when not an array of strings', () => {
    expect(validateManifest({ name: 'p', keywords: 'x' }, '/x/p').keywords).toBeUndefined();
    expect(validateManifest({ name: 'p', keywords: [1, 2] }, '/x/p').keywords).toBeUndefined();
  });

  it('does not pollute Object.prototype via __proto__/constructor keys', () => {
    const m = validateManifest(
      { name: 'p', ['__proto__']: { polluted: true }, constructor: { x: 1 } },
      '/x/p',
    );
    expect((m as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a name containing a newline (no multiline regex bypass)', () => {
    expect(() => validateManifest({ name: 'good\n../../etc' }, '/x/p')).toThrow(/kebab-case/);
  });

  it('drops version/description when not a string', () => {
    const m = validateManifest({ name: 'p', version: 1, description: ['x'] }, '/x/p');
    expect(m.version).toBeUndefined();
    expect(m.description).toBeUndefined();
  });

  it('drops skills/commands when given a non-array, non-string value', () => {
    const m = validateManifest({ name: 'p', skills: 1, commands: 2 }, '/x/p');
    expect(m.skills).toBeUndefined();
    expect(m.commands).toBeUndefined();
  });

  it('drops agents when given a non-array, non-string value', () => {
    expect(validateManifest({ name: 'p', agents: 1 }, '/x/p').agents).toBeUndefined();
  });
});

describe('readManifest', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-plugin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads and validates .claude-plugin/plugin.json', async () => {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(
      join(dir, MANIFEST_DIR, MANIFEST_FILENAME),
      JSON.stringify({ name: 'disco', version: '1.2.0' }),
    );
    const m = await readManifest(dir);
    expect(m.name).toBe('disco');
    expect(m.version).toBe('1.2.0');
  });

  it('derives a manifest from the dir name when the file is absent (optional manifest)', async () => {
    const sub = join(dir, 'auto-named');
    await mkdir(sub, { recursive: true });
    const m = await readManifest(sub);
    expect(m.name).toBe('auto-named');
  });

  it('throws on invalid JSON', async () => {
    await mkdir(join(dir, MANIFEST_DIR), { recursive: true });
    await writeFile(join(dir, MANIFEST_DIR, MANIFEST_FILENAME), '{ not json');
    await expect(readManifest(dir)).rejects.toThrow(/invalid JSON/);
  });
});

describe('resolveSkillDirs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-skills-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('includes the default skills/ dir when present and adds manifest paths', async () => {
    await mkdir(join(dir, 'skills'), { recursive: true });
    await mkdir(join(dir, 'extra'), { recursive: true });
    const dirs = resolveSkillDirs(dir, { name: 'p', skills: ['./extra'] });
    expect(dirs).toEqual([join(dir, 'skills'), join(dir, 'extra')]);
  });

  it('returns empty when no skills dir exists', () => {
    const dirs = resolveSkillDirs(dir, { name: 'p' });
    expect(dirs).toEqual([]);
  });

  it('ignores non-relative or missing manifest skill paths', async () => {
    await mkdir(join(dir, 'skills'), { recursive: true });
    const dirs = resolveSkillDirs(dir, { name: 'p', skills: ['/abs/path', './missing'] });
    expect(dirs).toEqual([join(dir, 'skills')]);
  });

  it('rejects a manifest skill path that escapes the plugin root via path traversal', async () => {
    // Set up: <tmpParent>/plug/ as the plugin root (with skills/) and
    // <tmpParent>/escape/ as the escape target outside the plugin root.
    const tmpParent = await mkdtemp(join(tmpdir(), 'cc-escape-'));
    const plugDir = join(tmpParent, 'plug');
    const escapeDir = join(tmpParent, 'escape');
    await mkdir(join(plugDir, 'skills'), { recursive: true });
    await mkdir(escapeDir, { recursive: true });
    try {
      // './../escape' resolves to <tmpParent>/escape — outside plugDir
      const dirs = resolveSkillDirs(plugDir, { name: 'p', skills: ['./../escape'] });
      expect(dirs).toEqual([join(plugDir, 'skills')]);
    } finally {
      await rm(tmpParent, { recursive: true, force: true });
    }
  });
});

describe('resolveCommandFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-cmd-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds flat .md files under the default commands/ dir', async () => {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'deploy.md'), '# deploy');
    await writeFile(join(dir, 'commands', 'rollback.md'), '# rollback');
    await writeFile(join(dir, 'commands', 'notes.txt'), 'ignore me');
    const files = resolveCommandFiles(dir, { name: 'p' }).sort();
    expect(files).toEqual([
      join(dir, 'commands', 'deploy.md'),
      join(dir, 'commands', 'rollback.md'),
    ]);
  });

  it('manifest commands REPLACES the default dir', async () => {
    await mkdir(join(dir, 'commands'), { recursive: true });
    await writeFile(join(dir, 'commands', 'default.md'), 'x');
    await mkdir(join(dir, 'custom'), { recursive: true });
    await writeFile(join(dir, 'custom', 'special.md'), 'y');
    const files = resolveCommandFiles(dir, { name: 'p', commands: ['./custom'] });
    expect(files).toEqual([join(dir, 'custom', 'special.md')]);
  });

  it('returns [] when no commands dir exists', () => {
    expect(resolveCommandFiles(dir, { name: 'p' })).toEqual([]);
  });
});

describe('resolveAgentFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-agent-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds flat .md files under the default agents/ dir', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'reviewer.md'), '# reviewer');
    await writeFile(join(dir, 'agents', 'planner.md'), '# planner');
    await writeFile(join(dir, 'agents', 'notes.txt'), 'ignore me');
    const files = resolveAgentFiles(dir, { name: 'p' }).sort();
    expect(files).toEqual([join(dir, 'agents', 'planner.md'), join(dir, 'agents', 'reviewer.md')]);
  });

  it('manifest agents ADDS to the default dir', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'default.md'), 'x');
    await mkdir(join(dir, 'custom'), { recursive: true });
    await writeFile(join(dir, 'custom', 'special.md'), 'y');
    const files = resolveAgentFiles(dir, { name: 'p', agents: ['./custom'] }).sort();
    expect(files).toEqual([join(dir, 'agents', 'default.md'), join(dir, 'custom', 'special.md')]);
  });

  it('uses a manifest agents path that points directly at an .md file', async () => {
    await writeFile(join(dir, 'lone.md'), 'z');
    const files = resolveAgentFiles(dir, { name: 'p', agents: ['./lone.md'] });
    expect(files).toEqual([join(dir, 'lone.md')]);
  });

  it('returns [] when no agents dir exists', () => {
    expect(resolveAgentFiles(dir, { name: 'p' })).toEqual([]);
  });

  it('ignores non-relative or missing manifest agent paths', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'a.md'), 'a');
    const files = resolveAgentFiles(dir, { name: 'p', agents: ['/abs/path', './missing'] });
    expect(files).toEqual([join(dir, 'agents', 'a.md')]);
  });
});

describe('resolveBinDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-bin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the bin/ dir when present, undefined otherwise', async () => {
    expect(resolveBinDir(dir)).toBeUndefined();
    await mkdir(join(dir, 'bin'), { recursive: true });
    expect(resolveBinDir(dir)).toBe(join(dir, 'bin'));
  });
});

describe('resolveProviderFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-prov-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds flat .json files under the default providers/ dir', async () => {
    await mkdir(join(dir, 'providers'), { recursive: true });
    await writeFile(join(dir, 'providers', 'acme.json'), '{}');
    await writeFile(join(dir, 'providers', 'beta.json'), '{}');
    await writeFile(join(dir, 'providers', 'notes.txt'), 'ignore me');
    const files = resolveProviderFiles(dir, { name: 'p' }).sort();
    expect(files).toEqual([
      join(dir, 'providers', 'acme.json'),
      join(dir, 'providers', 'beta.json'),
    ]);
  });

  it('manifest providers ADDS to the default dir', async () => {
    await mkdir(join(dir, 'providers'), { recursive: true });
    await writeFile(join(dir, 'providers', 'default.json'), '{}');
    await mkdir(join(dir, 'custom'), { recursive: true });
    await writeFile(join(dir, 'custom', 'special.json'), '{}');
    const files = resolveProviderFiles(dir, { name: 'p', providers: ['./custom'] }).sort();
    expect(files).toEqual([
      join(dir, 'custom', 'special.json'),
      join(dir, 'providers', 'default.json'),
    ]);
  });

  it('uses a manifest providers path that points directly at a .json file', async () => {
    await writeFile(join(dir, 'lone.json'), '{}');
    const files = resolveProviderFiles(dir, { name: 'p', providers: ['./lone.json'] });
    expect(files).toEqual([join(dir, 'lone.json')]);
  });

  it('dedupes a file reachable via both the default dir and a manifest entry', async () => {
    await mkdir(join(dir, 'providers'), { recursive: true });
    await writeFile(join(dir, 'providers', 'acme.json'), '{}');
    const files = resolveProviderFiles(dir, {
      name: 'p',
      providers: ['./providers', './providers/acme.json'],
    });
    expect(files).toEqual([join(dir, 'providers', 'acme.json')]);
  });

  it('returns [] when no providers dir exists', () => {
    expect(resolveProviderFiles(dir, { name: 'p' })).toEqual([]);
  });

  it('ignores non-relative or missing manifest provider paths', async () => {
    await mkdir(join(dir, 'providers'), { recursive: true });
    await writeFile(join(dir, 'providers', 'a.json'), '{}');
    const files = resolveProviderFiles(dir, {
      name: 'p',
      providers: ['/abs/path', './missing'],
    });
    expect(files).toEqual([join(dir, 'providers', 'a.json')]);
  });

  it('rejects a manifest provider path that escapes the plugin root via path traversal', async () => {
    const tmpParent = await mkdtemp(join(tmpdir(), 'cc-prov-escape-'));
    const plugDir = join(tmpParent, 'plug');
    const escapeDir = join(tmpParent, 'escape');
    await mkdir(join(plugDir, 'providers'), { recursive: true });
    await writeFile(join(plugDir, 'providers', 'a.json'), '{}');
    await mkdir(escapeDir, { recursive: true });
    await writeFile(join(escapeDir, 'evil.json'), '{}');
    try {
      const files = resolveProviderFiles(plugDir, { name: 'p', providers: ['./../escape'] });
      expect(files).toEqual([join(plugDir, 'providers', 'a.json')]);
    } finally {
      await rm(tmpParent, { recursive: true, force: true });
    }
  });

  it('skips a providers/ dir that is a symlink to an external dir (no throw)', async () => {
    const tmpParent = await mkdtemp(join(tmpdir(), 'cc-prov-symlink-'));
    const plugDir = join(tmpParent, 'plug');
    const external = join(tmpParent, 'external');
    await mkdir(plugDir, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'evil.json'), '{}');
    try {
      // Default providers/ root is a symlink pointing OUTSIDE the plugin dir.
      symlinkSync(external, join(plugDir, 'providers'));
      const files = resolveProviderFiles(plugDir, { name: 'p' });
      expect(files).toEqual([]);
    } finally {
      await rm(tmpParent, { recursive: true, force: true });
    }
  });

  it('skips an unreadable providers/ dir (no throw)', async () => {
    const tmpParent = await mkdtemp(join(tmpdir(), 'cc-prov-unreadable-'));
    const plugDir = join(tmpParent, 'plug');
    const provDir = join(plugDir, 'providers');
    await mkdir(provDir, { recursive: true });
    await writeFile(join(provDir, 'a.json'), '{}');
    try {
      await chmod(provDir, 0o000);
      expect(() => resolveProviderFiles(plugDir, { name: 'p' })).not.toThrow();
    } finally {
      await chmod(provDir, 0o755).catch(() => {});
      await rm(tmpParent, { recursive: true, force: true });
    }
  });
});

/**
 * Symlink-based sandbox-escape guards: a purely lexical containment check is
 * defeated by a symlink whose LEXICAL path stays inside the plugin dir but
 * whose REALPATH resolves outside. The resolvers must drop such components.
 */
describe('realpath containment (symlink sandbox escape)', () => {
  let tmpParent: string;
  let plugDir: string;
  let external: string;
  beforeEach(async () => {
    tmpParent = await mkdtemp(join(tmpdir(), 'cc-realpath-'));
    plugDir = join(tmpParent, 'plug');
    external = join(tmpParent, 'external');
    await mkdir(plugDir, { recursive: true });
    await mkdir(external, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmpParent, { recursive: true, force: true });
  });

  it('drops a default skills/ that is a symlink to an external dir', async () => {
    await writeFile(join(external, 'leak.md'), '# secret');
    symlinkSync(external, join(plugDir, 'skills'));
    expect(resolveSkillDirs(plugDir, { name: 'p' })).toEqual([]);
  });

  it('drops a default commands/ that is a symlink to an external dir', async () => {
    await writeFile(join(external, 'leak.md'), '# secret');
    symlinkSync(external, join(plugDir, 'commands'));
    expect(resolveCommandFiles(plugDir, { name: 'p' })).toEqual([]);
  });

  it('drops a default agents/ that is a symlink to an external dir', async () => {
    await writeFile(join(external, 'leak.md'), '# secret');
    symlinkSync(external, join(plugDir, 'agents'));
    expect(resolveAgentFiles(plugDir, { name: 'p' })).toEqual([]);
  });

  it('drops a manifest skills entry "./leak" symlinked to an external dir', async () => {
    await writeFile(join(external, 'leak.md'), '# secret');
    symlinkSync(external, join(plugDir, 'leak'));
    expect(resolveSkillDirs(plugDir, { name: 'p', skills: ['./leak'] })).toEqual([]);
  });

  it('drops a manifest commands entry "./leak" symlinked to an external dir', async () => {
    await writeFile(join(external, 'leak.md'), '# secret');
    symlinkSync(external, join(plugDir, 'leak'));
    expect(resolveCommandFiles(plugDir, { name: 'p', commands: ['./leak'] })).toEqual([]);
  });

  it('drops a manifest agents entry "./leak" symlinked to an external dir', async () => {
    await writeFile(join(external, 'leak.md'), '# secret');
    symlinkSync(external, join(plugDir, 'leak'));
    expect(resolveAgentFiles(plugDir, { name: 'p', agents: ['./leak'] })).toEqual([]);
  });

  it('drops a manifest providers entry "./leak" symlinked to an external dir', async () => {
    await writeFile(join(external, 'leak.json'), '{}');
    symlinkSync(external, join(plugDir, 'leak'));
    expect(resolveProviderFiles(plugDir, { name: 'p', providers: ['./leak'] })).toEqual([]);
  });

  it('skips a per-file symlink inside an otherwise-valid commands/ dir that escapes', async () => {
    const cmdDir = join(plugDir, 'commands');
    await mkdir(cmdDir, { recursive: true });
    await writeFile(join(cmdDir, 'real.md'), '# real');
    await writeFile(join(external, 'evil.md'), '# evil');
    // A per-file symlink inside the contained dir whose target escapes.
    symlinkSync(join(external, 'evil.md'), join(cmdDir, 'evil.md'));
    const files = resolveCommandFiles(plugDir, { name: 'p' });
    expect(files).toEqual([join(cmdDir, 'real.md')]);
  });

  it('skips a per-file symlink inside an otherwise-valid agents/ dir that escapes', async () => {
    const agentDir = join(plugDir, 'agents');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'real.md'), '# real');
    await writeFile(join(external, 'evil.md'), '# evil');
    symlinkSync(join(external, 'evil.md'), join(agentDir, 'evil.md'));
    const files = resolveAgentFiles(plugDir, { name: 'p' });
    expect(files).toEqual([join(agentDir, 'real.md')]);
  });

  it('skips a per-file symlink inside an otherwise-valid providers/ dir that escapes', async () => {
    const provDir = join(plugDir, 'providers');
    await mkdir(provDir, { recursive: true });
    await writeFile(join(provDir, 'real.json'), '{}');
    await writeFile(join(external, 'evil.json'), '{}');
    symlinkSync(join(external, 'evil.json'), join(provDir, 'evil.json'));
    const files = resolveProviderFiles(plugDir, { name: 'p' });
    expect(files).toEqual([join(provDir, 'real.json')]);
  });

  it('still resolves a normal nested (non-symlink) path correctly (no regression)', async () => {
    const skillsDir = join(plugDir, 'skills');
    const extra = join(plugDir, 'extra');
    await mkdir(skillsDir, { recursive: true });
    await mkdir(extra, { recursive: true });
    const dirs = resolveSkillDirs(plugDir, { name: 'p', skills: ['./extra'] });
    expect(dirs).toEqual([skillsDir, extra]);
  });

  it('skips a dangling/broken symlink without throwing', async () => {
    // skills/ → a target that does not exist (broken symlink).
    symlinkSync(join(external, 'does-not-exist'), join(plugDir, 'skills'));
    expect(() => resolveSkillDirs(plugDir, { name: 'p' })).not.toThrow();
    expect(resolveSkillDirs(plugDir, { name: 'p' })).toEqual([]);
  });
});

/**
 * Scan-hardening for commands/agents resolvers: a broken / unreadable / non-dir
 * (ENOTDIR) path must DROP that component, not throw (which would downgrade the
 * whole plugin to an `error` record).
 */
describe('command/agent scan hardening (no throw on bad dir)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-scanguard-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolveCommandFiles: a commands entry pointing at a regular file (ENOTDIR) is skipped', async () => {
    await writeFile(join(dir, 'x.md'), '# x');
    // './x.md' is contained + exists but is a FILE — readdirSync would throw ENOTDIR.
    expect(() => resolveCommandFiles(dir, { name: 'p', commands: ['./x.md'] })).not.toThrow();
    expect(resolveCommandFiles(dir, { name: 'p', commands: ['./x.md'] })).toEqual([]);
  });

  it('resolveAgentFiles: an unreadable agents/ dir is skipped (other components still resolve)', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'a.md'), '# a');
    try {
      await chmod(join(dir, 'agents'), 0o000);
      expect(() => resolveAgentFiles(dir, { name: 'p' })).not.toThrow();
    } finally {
      await chmod(join(dir, 'agents'), 0o755).catch(() => {});
    }
  });
});
