import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { parseFrontmatter } from './frontmatter.js';
import { isValidSkillName } from './validate.js';

const execFileAsync = promisify(execFile);

export type ParsedSkillSource =
  | { kind: 'git'; owner: string; repo: string; subpath?: string; ref?: string }
  | { kind: 'url'; url: string }
  | { kind: 'local'; path: string };

export interface SkillFile {
  /** Path relative to the skill root (e.g. `SKILL.md`, `references/api.md`). */
  path: string;
  content: string;
}

export interface FetchedSkill {
  name: string;
  files: SkillFile[];
}

/**
 * Parse a skill install source. Supported forms:
 * - `git:owner/repo[/subpath][@ref]`
 * - `https://…/SKILL.md`
 * - a local filesystem path (absolute, relative, or `~/`)
 */
export function parseSkillSource(raw: string): ParsedSkillSource {
  const s = raw.trim();

  if (s.startsWith('git:')) {
    let rest = s.slice(4);
    let ref: string | undefined;
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      ref = rest.slice(at + 1) || undefined;
      rest = rest.slice(0, at);
    }
    const parts = rest.split('/').filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`Invalid git source "${raw}". Expected git:owner/repo[/subpath][@ref].`);
    }
    const [owner, repo, ...sub] = parts;
    return { kind: 'git', owner, repo, subpath: sub.length ? sub.join('/') : undefined, ref };
  }

  if (s.startsWith('http://') || s.startsWith('https://')) {
    return { kind: 'url', url: s };
  }

  return { kind: 'local', path: s };
}

/** Resolve and validate the skill's canonical name. */
function resolveName(skillMd: string, override?: string): string {
  const name = override ?? parseFrontmatter(skillMd)?.frontmatter.name;
  if (!name) {
    throw new Error(
      'Skill has no name (SKILL.md frontmatter missing a name and no override given).',
    );
  }
  if (!isValidSkillName(name)) {
    throw new Error(
      `Invalid skill name "${name}". Use lowercase letters, digits, and hyphens (max 64 chars).`,
    );
  }
  return name;
}

/** Collect SKILL.md plus any other `.md` files, stripping scripts/assets (text-only v1). */
async function collectMarkdown(skillDir: string): Promise<SkillFile[]> {
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    throw new Error(`No SKILL.md found at ${skillDir}.`);
  }
  const files: SkillFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        files.push({ path: relative(skillDir, full), content: await readFile(full, 'utf-8') });
      }
    }
  };
  await walk(skillDir);
  return files;
}

/**
 * Fetch a skill from a parsed source, returning its text-only files (SKILL.md +
 * any `.md`) and resolved name. Executable scripts and binary assets are
 * stripped. Throws on any fetch/parse failure.
 */
export async function fetchSkill(
  source: ParsedSkillSource,
  nameOverride?: string,
): Promise<FetchedSkill> {
  if (source.kind === 'url') {
    const res = await fetch(source.url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${source.url}: HTTP ${res.status}`);
    }
    const content = await res.text();
    return { name: resolveName(content, nameOverride), files: [{ path: 'SKILL.md', content }] };
  }

  if (source.kind === 'git') {
    const tmp = await mkdtemp(join(tmpdir(), 'dash-skill-git-'));
    try {
      const repoUrl = `https://github.com/${source.owner}/${source.repo}.git`;
      try {
        const args = ['clone', '--depth', '1'];
        if (source.ref) args.push('--branch', source.ref);
        args.push(repoUrl, tmp);
        await execFileAsync('git', args);
      } catch {
        // `--branch` rejects commit SHAs; fall back to a full clone + checkout.
        await rm(tmp, { recursive: true, force: true });
        await mkdir(tmp, { recursive: true });
        await execFileAsync('git', ['clone', repoUrl, tmp]);
        if (source.ref) await execFileAsync('git', ['-C', tmp, 'checkout', source.ref]);
      }
      const skillDir = source.subpath ? join(tmp, source.subpath) : tmp;
      const files = await collectMarkdown(skillDir);
      const skillMd = files.find((f) => f.path === 'SKILL.md')?.content ?? '';
      return { name: resolveName(skillMd, nameOverride), files };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // local
  const expanded = source.path.startsWith('~/') ? source.path.replace('~', homedir()) : source.path;
  const info = await stat(expanded);
  const skillDir = info.isDirectory() ? expanded : dirname(expanded);
  const files = await collectMarkdown(skillDir);
  const skillMd = files.find((f) => f.path === 'SKILL.md')?.content ?? '';
  return { name: resolveName(skillMd, nameOverride), files };
}
