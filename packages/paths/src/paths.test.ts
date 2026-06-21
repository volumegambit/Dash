import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dashHome, desktopDir, gatewayDir, logsDir, workspacesDir } from './paths.js';

describe('dashHome', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to ~/.dash when DASH_HOME is unset', () => {
    vi.stubEnv('DASH_HOME', '');
    expect(dashHome()).toBe(join(homedir(), '.dash'));
  });

  it('treats a whitespace-only DASH_HOME as unset', () => {
    vi.stubEnv('DASH_HOME', '   ');
    expect(dashHome()).toBe(join(homedir(), '.dash'));
  });

  it('honors a custom DASH_HOME', () => {
    vi.stubEnv('DASH_HOME', '/custom/root');
    expect(dashHome()).toBe('/custom/root');
  });
});

describe('subdirectory resolvers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('compose under the resolved root', () => {
    vi.stubEnv('DASH_HOME', '/r');
    expect(gatewayDir()).toBe('/r/gateway');
    expect(desktopDir()).toBe('/r/desktop');
    expect(logsDir()).toBe('/r/logs');
    expect(workspacesDir()).toBe('/r/workspaces');
  });
});
