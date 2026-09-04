import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_IMPORT_MARKER,
  LEGACY_MEMORY_NAME,
  importLegacyMemoryFile,
} from './import-legacy.js';
import { MemoryStore } from './store.js';

describe('importLegacyMemoryFile', () => {
  let root: string;
  let workspace: string;
  let store: MemoryStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dash-legacy-'));
    workspace = join(root, 'ws');
    await writeFile(join(root, 'placeholder'), '');
    store = new MemoryStore(join(root, 'mem'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns false when there is no workspace or no MEMORY.md', async () => {
    expect(await importLegacyMemoryFile(store, undefined)).toBe(false);
    expect(await importLegacyMemoryFile(store, workspace)).toBe(false);
  });

  it('imports a non-empty MEMORY.md once as a project memory and leaves the file alone', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), '# Notes\n- User name: Gerry\n');
    expect(await importLegacyMemoryFile(store, workspace)).toBe(true);
    const rec = await store.get(LEGACY_MEMORY_NAME);
    expect(rec?.type).toBe('project');
    expect(rec?.source).toBe('import');
    expect(rec?.content).toContain('User name: Gerry');
    // second call: marker present → no re-import
    expect(await importLegacyMemoryFile(store, workspace)).toBe(false);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toContain('Gerry');
  });

  it('does not import when the store already has memories', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), 'x');
    await store.save({ name: 'a', description: 'd', type: 'user', content: 'c', source: 'agent' });
    // no marker yet — the secondary count() guard still blocks the import
    expect(await readdir(store.dir)).not.toContain(LEGACY_IMPORT_MARKER);
    expect(await importLegacyMemoryFile(store, workspace)).toBe(false);
    expect(await store.get(LEGACY_MEMORY_NAME)).toBeNull();
  });

  it('writes the import marker into the store dir after a successful import', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), 'notes');
    expect(await importLegacyMemoryFile(store, workspace)).toBe(true);
    expect((await stat(join(store.dir, LEGACY_IMPORT_MARKER))).isFile()).toBe(true);
  });

  it('does not resurrect the imported memory after the user deletes it', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), '- likes tea\n');
    expect(await importLegacyMemoryFile(store, workspace)).toBe(true);
    expect(await store.remove(LEGACY_MEMORY_NAME)).toBe(true);
    expect(await store.count()).toBe(0);
    // store is empty again, but the marker means the import is done for good
    expect(await importLegacyMemoryFile(store, workspace)).toBe(false);
    expect(await store.get(LEGACY_MEMORY_NAME)).toBeNull();
  });

  it('keeps the marker out of the memory listing', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), 'notes');
    expect(await importLegacyMemoryFile(store, workspace)).toBe(true);
    expect(await readdir(store.dir)).toContain(LEGACY_IMPORT_MARKER);
    expect((await store.list()).map((m) => m.name)).toEqual([LEGACY_MEMORY_NAME]);
  });

  it('truncates oversized legacy files to the import cap with a note', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), 'y'.repeat(20000));
    expect(await importLegacyMemoryFile(store, workspace)).toBe(true);
    const rec = await store.get(LEGACY_MEMORY_NAME);
    expect(rec?.content.length).toBeLessThanOrEqual(8192);
    expect(rec?.content.endsWith('[truncated]')).toBe(true);
  });
});
