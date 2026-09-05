import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMemoryPreamble } from './memory.js';

describe('buildMemoryPreamble', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-memory-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('returns "not yet created" preamble when MEMORY.md does not exist', async () => {
    const preamble = await buildMemoryPreamble(dir);
    expect(preamble).toContain('not yet created');
    expect(preamble).toContain('MEMORY.md');
  });

  it('returns preamble with memory contents when MEMORY.md exists', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '# Memory\n- User name: Gerry');
    const preamble = await buildMemoryPreamble(dir);
    expect(preamble).toContain('Current memory:');
    expect(preamble).toContain('User name: Gerry');
    expect(preamble).toContain('MEMORY.md');
  });

  it('returns "not yet created" preamble when MEMORY.md is empty', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '   ');
    const preamble = await buildMemoryPreamble(dir);
    expect(preamble).toContain('not yet created');
  });

  /**
   * The default preamble tells the reader to REWRITE the file with write_file.
   * Handing that to several concurrent sub-agents on one shared workspace is a
   * lost-update pattern on a user-visible artifact, so a child reads only.
   */
  describe('readOnly', () => {
    it('keeps the memory body but drops every instruction to write it', async () => {
      await writeFile(join(dir, 'MEMORY.md'), '# Memory\n- User name: Gerry');
      const preamble = await buildMemoryPreamble(dir, { readOnly: true });
      expect(preamble).toContain('Current memory:');
      expect(preamble).toContain('User name: Gerry');
      expect(preamble).not.toContain('write_file');
      expect(preamble).not.toContain('Proactively update');
    });

    it('does not invite a child to create the file when there is none', async () => {
      const preamble = await buildMemoryPreamble(dir, { readOnly: true });
      expect(preamble).not.toContain('write_file');
      expect(preamble).toContain('MEMORY.md');
    });

    it('leaves the default (writable) preamble untouched', async () => {
      await writeFile(join(dir, 'MEMORY.md'), '# Memory\n- User name: Gerry');
      const preamble = await buildMemoryPreamble(dir, { readOnly: false });
      expect(preamble).toBe(await buildMemoryPreamble(dir));
      expect(preamble).toContain('write_file');
      expect(preamble).toContain('Proactively update');
    });
  });
});
