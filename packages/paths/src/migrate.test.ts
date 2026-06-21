import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyLayout } from './migrate.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('migrateLegacyLayout', () => {
  let base: string;
  let newRoot: string;
  let legacyGatewayDir: string;
  let legacyDesktopDir: string;
  let legacyWorkspacesDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dash-migrate-'));
    newRoot = join(base, 'new', '.dash');
    legacyGatewayDir = join(base, 'legacy-gateway');
    legacyDesktopDir = join(base, 'legacy-desktop');
    legacyWorkspacesDir = join(base, 'legacy-workspaces');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const opts = () => ({ newRoot, legacyGatewayDir, legacyDesktopDir, legacyWorkspacesDir });

  async function seedLegacy(): Promise<void> {
    // Gateway data (all current).
    await mkdir(join(legacyGatewayDir, 'sessions'), { recursive: true });
    await writeFile(join(legacyGatewayDir, 'credentials.enc'), 'secret');
    await writeFile(join(legacyGatewayDir, 'sessions', 's.jsonl'), 'line');

    // Desktop dir: current files + dead cruft.
    await mkdir(join(legacyDesktopDir, 'conversations'), { recursive: true });
    await mkdir(join(legacyDesktopDir, 'logs'), { recursive: true });
    await writeFile(join(legacyDesktopDir, 'settings.json'), '{}');
    await writeFile(join(legacyDesktopDir, 'gateway-state.json'), '{}');
    await writeFile(join(legacyDesktopDir, 'conversations', 'c.json'), '{}');
    await writeFile(join(legacyDesktopDir, 'logs', 'mc.log'), 'log');
    await writeFile(join(legacyDesktopDir, 'secrets.enc'), 'old'); // cruft
    await writeFile(join(legacyDesktopDir, 'models-cache.json'), 'old'); // cruft

    // Workspaces.
    await mkdir(join(legacyWorkspacesDir, 'agent-a'), { recursive: true });
    await writeFile(join(legacyWorkspacesDir, 'agent-a', 'file.txt'), 'x');
  }

  it('moves gateway and workspaces wholesale and desktop selectively', async () => {
    await seedLegacy();

    const result = await migrateLegacyLayout(opts());

    expect(result.skipped).toBe(false);
    expect(result.moved.length).toBeGreaterThan(0);

    // Gateway moved whole.
    expect(await exists(join(newRoot, 'gateway', 'credentials.enc'))).toBe(true);
    expect(await exists(join(newRoot, 'gateway', 'sessions', 's.jsonl'))).toBe(true);

    // Workspaces moved whole.
    expect(await exists(join(newRoot, 'workspaces', 'agent-a', 'file.txt'))).toBe(true);

    // Desktop current files moved.
    expect(await exists(join(newRoot, 'desktop', 'settings.json'))).toBe(true);
    expect(await exists(join(newRoot, 'desktop', 'gateway-state.json'))).toBe(true);
    expect(await exists(join(newRoot, 'desktop', 'conversations', 'c.json'))).toBe(true);

    // Logs split to shared logs dir.
    expect(await exists(join(newRoot, 'logs', 'mc.log'))).toBe(true);

    // Cruft NOT moved — left at the legacy location.
    expect(await exists(join(newRoot, 'desktop', 'secrets.enc'))).toBe(false);
    expect(await exists(join(newRoot, 'desktop', 'models-cache.json'))).toBe(false);
    expect(await exists(join(legacyDesktopDir, 'secrets.enc'))).toBe(true);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second run moves nothing', async () => {
    await seedLegacy();
    await migrateLegacyLayout(opts());

    const second = await migrateLegacyLayout(opts());
    expect(second.skipped).toBe(false);
    expect(second.moved).toEqual([]);
  });

  it('does not overwrite an existing destination', async () => {
    await seedLegacy();
    // Pre-existing gateway dest with different content must be preserved.
    await mkdir(join(newRoot, 'gateway'), { recursive: true });
    await writeFile(join(newRoot, 'gateway', 'keep.txt'), 'keep');

    await migrateLegacyLayout(opts());

    expect(await exists(join(newRoot, 'gateway', 'keep.txt'))).toBe(true);
    // Legacy gateway left untouched since the dest already existed.
    expect(await exists(join(legacyGatewayDir, 'credentials.enc'))).toBe(true);
  });

  it('is a no-op when no legacy data exists', async () => {
    const result = await migrateLegacyLayout(opts());
    expect(result.moved).toEqual([]);
    expect(await exists(newRoot)).toBe(false);
  });

  it('skips when DASH_HOME is set and no newRoot override is given', async () => {
    vi.stubEnv('DASH_HOME', join(base, 'custom'));
    await seedLegacy();

    const result = await migrateLegacyLayout({
      legacyGatewayDir,
      legacyDesktopDir,
      legacyWorkspacesDir,
    });

    expect(result.skipped).toBe(true);
    expect(result.moved).toEqual([]);
    // Legacy data left untouched.
    expect(await exists(join(legacyGatewayDir, 'credentials.enc'))).toBe(true);
  });
});
