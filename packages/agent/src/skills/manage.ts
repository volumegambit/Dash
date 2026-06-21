import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generateFrontmatter, parseFrontmatter } from './frontmatter.js';
import { fetchSkill, parseSkillSource } from './install.js';
import { scanSkillsDirectory } from './scanner.js';
import type { SkillScanVerdict, SkillSecurityScanner } from './security.js';
import type { SkillDiscoveryResult, SkillFrontmatter } from './types.js';
import { isValidSkillName } from './validate.js';

export type SkillOpCode =
  | 'not_found'
  | 'bundled'
  | 'dangerous'
  | 'duplicate'
  | 'invalid'
  | 'scan_failed';

/** Typed failure for a skill management operation. Callers map `code` to a UI/HTTP status. */
export class SkillOpError extends Error {
  constructor(
    readonly code: SkillOpCode,
    message: string,
  ) {
    super(message);
    this.name = 'SkillOpError';
  }
}

export interface WrittenSkill {
  name: string;
  location: string;
}

export interface InstalledSkill extends WrittenSkill {
  verdict: SkillScanVerdict;
}

/**
 * Create a new skill in the managed directory. Throws SkillOpError
 * (`invalid` | `duplicate`) on failure.
 */
export async function createSkillInDir(o: {
  managedDir: string;
  name: string;
  description: string;
  content: string;
  frontmatter?: Partial<SkillFrontmatter>;
}): Promise<WrittenSkill> {
  if (!isValidSkillName(o.name)) {
    throw new SkillOpError(
      'invalid',
      'Invalid skill name. Must be lowercase alphanumeric with hyphens, max 64 characters, and start with a letter or digit.',
    );
  }
  if (!o.content.trim()) {
    throw new SkillOpError(
      'invalid',
      'Skill content cannot be empty. Provide self-contained instructions.',
    );
  }
  const skillDir = join(o.managedDir, o.name);
  if (existsSync(skillDir)) {
    throw new SkillOpError(
      'duplicate',
      `Skill "${o.name}" already exists at ${skillDir}. Choose a different name.`,
    );
  }
  const fm: SkillFrontmatter = { ...o.frontmatter, name: o.name, description: o.description };
  await mkdir(skillDir, { recursive: true });
  const location = join(skillDir, 'SKILL.md');
  await writeFile(location, generateFrontmatter(fm, o.content), 'utf-8');
  await writeFile(join(skillDir, '.source'), 'agent', 'utf-8');
  return { name: o.name, location };
}

/**
 * Replace a managed skill's body, preserving its frontmatter. Only skills in
 * the managed directory are editable. Throws SkillOpError(`not_found`).
 */
export async function updateSkillBody(o: {
  managedDir: string;
  name: string;
  body: string;
}): Promise<WrittenSkill> {
  const managed = await scanSkillsDirectory(o.managedDir, 'managed');
  const existing = managed.find((s) => s.name === o.name);
  if (!existing) {
    throw new SkillOpError(
      'not_found',
      `Skill "${o.name}" is not in this agent's managed directory.`,
    );
  }
  const raw = await readFile(existing.location, 'utf-8');
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new SkillOpError('not_found', `Skill "${o.name}" has no valid SKILL.md.`);
  }
  await writeFile(existing.location, generateFrontmatter(parsed.frontmatter, o.body), 'utf-8');
  return { name: o.name, location: existing.location };
}

/**
 * Fetch a text-only skill (git/URL/local), security-scan it (fail-closed), and
 * write it to the managed directory. Throws SkillOpError
 * (`invalid` | `duplicate` | `scan_failed` | `dangerous`).
 */
export async function installSkillToDir(o: {
  managedDir: string;
  source: string;
  name?: string;
  scanner: SkillSecurityScanner;
}): Promise<InstalledSkill> {
  let fetched: Awaited<ReturnType<typeof fetchSkill>>;
  try {
    fetched = await fetchSkill(parseSkillSource(o.source), o.name);
  } catch (e) {
    throw new SkillOpError('invalid', `Could not fetch skill: ${(e as Error).message}`);
  }

  const skillDir = join(o.managedDir, fetched.name);
  if (existsSync(skillDir)) {
    throw new SkillOpError(
      'duplicate',
      `Skill "${fetched.name}" is already installed. Remove it first to reinstall.`,
    );
  }

  const skillMd = fetched.files.find((f) => f.path === 'SKILL.md')?.content ?? '';
  let verdict: SkillScanVerdict;
  try {
    verdict = await o.scanner(skillMd);
  } catch (e) {
    throw new SkillOpError(
      'scan_failed',
      `The security scan failed (${(e as Error).message}). Install is blocked when the scan cannot complete.`,
    );
  }
  if (verdict.verdict === 'dangerous') {
    throw new SkillOpError(
      'dangerous',
      `The security scan flagged "${fetched.name}" as dangerous (${verdict.reasons.join('; ') || 'no details'}).`,
    );
  }

  try {
    await mkdir(skillDir, { recursive: true });
    for (const file of fetched.files) {
      const dest = join(skillDir, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, 'utf-8');
    }
    await writeFile(join(skillDir, '.source'), 'remote', 'utf-8');
  } catch (e) {
    await rm(skillDir, { recursive: true, force: true });
    throw new SkillOpError(
      'invalid',
      `Failed to write skill "${fetched.name}": ${(e as Error).message}`,
    );
  }

  return { name: fetched.name, location: join(skillDir, 'SKILL.md'), verdict };
}

/**
 * Remove a managed/agent/remote skill. Bundled skills are read-only. Throws
 * SkillOpError(`not_found` | `bundled`).
 */
export async function removeSkillFromDir(o: {
  managedDir: string;
  name: string;
  listFn: () => Promise<SkillDiscoveryResult[]>;
}): Promise<{ name: string }> {
  const match = (await o.listFn()).find((s) => s.name === o.name);
  if (!match) {
    throw new SkillOpError('not_found', `Skill "${o.name}" not found.`);
  }
  if (match.source === 'bundled') {
    throw new SkillOpError(
      'bundled',
      `Skill "${o.name}" is a bundled skill and cannot be removed. You can shadow it by installing a skill with the same name.`,
    );
  }
  const skillDir = join(o.managedDir, o.name);
  if (!existsSync(skillDir)) {
    throw new SkillOpError(
      'not_found',
      `Skill "${o.name}" is not in this agent's managed directory, so it can't be removed here.`,
    );
  }
  await rm(skillDir, { recursive: true, force: true });
  return { name: o.name };
}
