import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
