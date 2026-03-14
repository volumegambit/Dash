import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatformDataDir } from './platform-paths.js';

describe('getPlatformDataDir', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    vi.unstubAllEnvs();
  });

  it('returns XDG_DATA_HOME/<appName> on linux when XDG_DATA_HOME is set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('XDG_DATA_HOME', '/custom/data');
    expect(getPlatformDataDir('dash')).toBe('/custom/data/dash');
  });

  it('returns ~/.local/share/<appName> on linux when XDG_DATA_HOME is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('XDG_DATA_HOME', '');
    expect(getPlatformDataDir('dash')).toBe(join(homedir(), '.local', 'share', 'dash'));
  });

  it('returns ~/Library/Application Support/<appName> on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    expect(getPlatformDataDir('dash')).toBe(
      join(homedir(), 'Library', 'Application Support', 'dash'),
    );
  });

  it('falls back to ~/.local/share/<appName> on non-darwin platforms without XDG', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('XDG_DATA_HOME', '');
    expect(getPlatformDataDir('dash')).toBe(join(homedir(), '.local', 'share', 'dash'));
  });
});
