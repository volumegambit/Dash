import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyDataDir } from './migration.js';

describe('migrateLegacyDataDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `migration-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('does nothing when old dir does not exist', async () => {
    const oldDir = join(tmp, 'old');
    const newDir = join(tmp, 'new');
    await migrateLegacyDataDir(oldDir, newDir);
    expect(existsSync(newDir)).toBe(false);
  });

  it('does nothing when new dir already exists', async () => {
    const oldDir = join(tmp, 'old');
    const newDir = join(tmp, 'new');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, 'file.txt'), 'old');
    await migrateLegacyDataDir(oldDir, newDir);
    // new dir still empty (we didn't migrate)
    expect(readdirSync(newDir)).toHaveLength(0);
  });

  it('moves old dir to new location when old exists and new does not', async () => {
    const oldDir = join(tmp, 'old');
    const newDir = join(tmp, 'new');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'registry.json'), '{}');
    await migrateLegacyDataDir(oldDir, newDir);
    expect(existsSync(newDir)).toBe(true);
    expect(readdirSync(newDir)).toContain('registry.json');
    expect(existsSync(oldDir)).toBe(false);
  });

  it('is a no-op on second call after migration', async () => {
    const oldDir = join(tmp, 'old');
    const newDir = join(tmp, 'new');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'registry.json'), '{}');
    await migrateLegacyDataDir(oldDir, newDir);
    // Second call — new exists, old doesn't
    await migrateLegacyDataDir(oldDir, newDir);
    expect(readdirSync(newDir)).toContain('registry.json');
  });
});
