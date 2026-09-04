import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_MEMORY_NAME, importLegacyMemoryFile } from './import-legacy.js';
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
    // second call: store not empty → no re-import
    expect(await importLegacyMemoryFile(store, workspace)).toBe(false);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toContain('Gerry');
  });

  it('does not import when the store already has memories', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), 'x');
    await store.save({ name: 'a', description: 'd', type: 'user', content: 'c', source: 'agent' });
    expect(await importLegacyMemoryFile(store, workspace)).toBe(false);
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
