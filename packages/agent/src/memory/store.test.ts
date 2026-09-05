import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, parseMemoryFile, serializeMemory } from './store.js';
import { MemoryOpError } from './types.js';

describe('MemoryStore', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-memory-store-'));
    store = new MemoryStore(join(dir, 'agent-1'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists nothing for a missing directory', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('saves a memory as a flat-frontmatter file and regenerates MEMORY.md', async () => {
    const { record, action } = await store.save({
      name: 'user-timezone',
      description: 'Gerry is in Singapore (UTC+8)',
      type: 'user',
      content: 'Gerry lives in Singapore.',
      source: 'agent',
    });
    expect(action).toBe('created');
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const raw = await readFile(join(store.dir, 'user-timezone.md'), 'utf8');
    expect(raw).toContain('---\nname: user-timezone\n');
    expect(raw).toContain('type: user\n');
    expect(raw).toContain('source: agent\n');
    expect(raw.endsWith('Gerry lives in Singapore.\n')).toBe(true);
    const index = await readFile(store.indexPath, 'utf8');
    expect(index).toContain('- **user-timezone** — Gerry is in Singapore (UTC+8)');
  });

  it('updates an existing memory keeping createdAt and reports "updated"', async () => {
    await store.save({
      name: 'a',
      description: 'd1',
      type: 'user',
      content: 'c1',
      source: 'agent',
    });
    const first = await store.get('a');
    const { record, action } = await store.save({
      name: 'a',
      description: 'd2',
      type: 'project',
      content: 'c2',
      source: 'sweep',
    });
    expect(action).toBe('updated');
    expect(record.createdAt).toBe(first?.createdAt);
    expect(record.description).toBe('d2');
    expect(record.type).toBe('project');
    expect((await store.list()).length).toBe(1);
  });

  it('removes a memory and regenerates the index', async () => {
    await store.save({ name: 'a', description: 'd', type: 'user', content: 'c', source: 'agent' });
    expect(await store.remove('a')).toBe(true);
    expect(await store.remove('a')).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await readFile(store.indexPath, 'utf8')).toContain('_No memories yet._');
  });

  it('rejects invalid names, long descriptions, multi-line descriptions and long content', async () => {
    const base = {
      description: 'd',
      type: 'user' as const,
      content: 'c',
      source: 'agent' as const,
    };
    await expect(store.save({ ...base, name: 'Bad Name' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      store.save({ ...base, name: 'ok', description: 'x'.repeat(201) }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.save({ ...base, name: 'ok', description: 'a\nb' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      store.save({ ...base, name: 'ok', content: 'x'.repeat(2049) }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      store.save({ ...base, name: 'ok', content: 'x'.repeat(2049), source: 'import' }),
    ).resolves.toBeTruthy();
    await expect(
      store.save({ ...base, name: 'ok2', content: 'x'.repeat(8193), source: 'import' }),
    ).rejects.toBeInstanceOf(MemoryOpError);
  });

  it('rejects invalid and newline-containing sources', async () => {
    const base = {
      name: 'test',
      description: 'd',
      type: 'user' as const,
      content: 'c',
    };
    await expect(store.save({ ...base, source: 'bogus' as MemorySource })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      store.save({
        ...base,
        source: 'agent\ndescription: injected' as MemorySource,
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      store.save({ ...base, source: 'agent\n---\n...' as MemorySource }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('enforces the per-agent cap for creates but not updates', async () => {
    const small = new MemoryStore(join(dir, 'capped'), { perAgent: 2 });
    await small.save({ name: 'a', description: 'd', type: 'user', content: 'c', source: 'agent' });
    await small.save({ name: 'b', description: 'd', type: 'user', content: 'c', source: 'agent' });
    await expect(
      small.save({ name: 'c', description: 'd', type: 'user', content: 'c', source: 'agent' }),
    ).rejects.toMatchObject({ code: 'limit' });
    await expect(
      small.save({ name: 'b', description: 'd2', type: 'user', content: 'c', source: 'agent' }),
    ).resolves.toMatchObject({ action: 'updated' });
  });

  it('preserves a user-authored source when the agent or the sweep updates it', async () => {
    for (const [existing, incoming] of [
      ['user', 'agent'],
      ['user', 'sweep'],
      ['import', 'agent'],
      ['import', 'sweep'],
    ] as const) {
      const name = `m-${existing}-${incoming}`;
      await store.save({ name, description: 'd', type: 'user', content: 'c', source: existing });
      const { record } = await store.save({
        name,
        description: 'refined',
        type: 'user',
        content: 'c2',
        source: incoming,
      });
      // The write still lands — only the provenance is protected.
      expect(record.content).toBe('c2');
      expect(record.source).toBe(existing);
      expect((await store.get(name))?.source).toBe(existing);
    }
  });

  it('lets the user path (re)claim a memory the agent wrote', async () => {
    await store.save({ name: 'a', description: 'd', type: 'user', content: 'c', source: 'agent' });
    const { record } = await store.save({
      name: 'a',
      description: 'd',
      type: 'user',
      content: 'c2',
      source: 'user',
    });
    expect(record.source).toBe('user');
  });

  it('skips unparsable files and ignores MEMORY.md when listing', async () => {
    await store.save({
      name: 'good',
      description: 'd',
      type: 'user',
      content: 'c',
      source: 'agent',
    });
    await writeFile(join(store.dir, 'junk.md'), 'no frontmatter here');
    await writeFile(
      join(store.dir, 'bad-type.md'),
      '---\nname: bad-type\ndescription: x\ntype: nope\n---\nbody\n',
    );
    const names = (await store.list()).map((m) => m.name);
    expect(names).toEqual(['good']);
  });
});

describe('parseMemoryFile / serializeMemory', () => {
  it('round-trips and falls back to the filename when name is missing', () => {
    const record = {
      name: 'n',
      description: 'd',
      type: 'feedback' as const,
      source: 'user' as const,
      createdAt: '2026-09-01',
      updatedAt: '2026-09-05',
      content: 'body\n\n**Why:** because.',
    };
    expect(parseMemoryFile(serializeMemory(record), 'n')).toEqual(record);
    const noName = parseMemoryFile('---\ndescription: d\ntype: user\n---\nbody', 'from-file');
    expect(noName?.name).toBe('from-file');
    expect(noName?.source).toBe('agent');
    expect(parseMemoryFile('plain text', 'x')).toBeNull();
  });
});
