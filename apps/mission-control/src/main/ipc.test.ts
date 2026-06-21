import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to import makePackagedSpawner — it doesn't exist yet, so this will fail
// Import it from ipc.ts after you implement it
import {
  isSetupConfigured,
  makePackagedSpawner,
  pluginInstallHandler,
  pluginReloadHandler,
  pluginRemoveHandler,
  pluginSetStateHandler,
  pluginsListHandler,
  resolveSetupStatus,
  shutdownGatewayOnQuit,
} from './ipc.js';

describe('makePackagedSpawner', () => {
  it('replaces node with execPath and adds ELECTRON_RUN_AS_NODE=1 when packaged', () => {
    const spawned: { command: string; env: Record<string, string | undefined> }[] = [];
    const testSpawner = {
      spawn: (
        command: string,
        args: string[],
        options: { env?: Record<string, string | undefined> },
      ) => {
        spawned.push({ command, env: options.env ?? {} });
        return { exitCode: null, kill: vi.fn(), on: vi.fn(), stdout: null, stderr: null };
      },
    };

    const fakeExecPath = '/Applications/Dash.app/Contents/MacOS/Dash';
    const packaged = makePackagedSpawner(fakeExecPath, testSpawner, true);
    packaged.spawn('node', ['script.js'], { env: { FOO: 'bar' } });

    expect(spawned[0].command).toBe(fakeExecPath);
    expect(spawned[0].env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(spawned[0].env.FOO).toBe('bar');
  });

  it('passes through to base spawner when not packaged', () => {
    const spawned: { command: string }[] = [];
    const testSpawner = {
      spawn: (command: string, _args: string[], _options: object) => {
        spawned.push({ command });
        return { exitCode: null, kill: vi.fn(), on: vi.fn(), stdout: null, stderr: null };
      },
    };

    const notPackaged = makePackagedSpawner('/path/to/electron', testSpawner, false);
    notPackaged.spawn('node', ['script.js'], { env: {} });

    expect(spawned[0].command).toBe('node');
  });
});

describe('shutdownGatewayOnQuit', () => {
  // Regression guard: the quit handler used to call `store.clear()` here,
  // which deleted gateway-state.json on every MC shutdown. The file
  // doubles as the "first-run detection" signal at boot, so clearing it
  // made every subsequent launch re-trip the setup-wizard deferral path.
  // Fix: kill the process but leave the file. ensureRunning() cleans up
  // the stale record on next launch when it probes the now-free port.
  let tmpDir: string;
  let stateFile: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mc-shutdown-'));
    stateFile = join(tmpDir, 'gateway-state.json');
    // Swallow SIGTERMs — the function calls process.kill on a fake pid
    // and we don't want to actually signal real processes in the runner.
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(async () => {
    killSpy.mockRestore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeState(state: {
    pid: number;
    startedAt: string;
    port: number;
    channelPort: number;
  }): Promise<void> {
    await writeFile(stateFile, JSON.stringify(state, null, 2));
  }

  it('leaves gateway-state.json on disk so first-run detection stays stable', async () => {
    await writeState({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });
    expect(existsSync(stateFile)).toBe(true);

    await shutdownGatewayOnQuit(tmpDir);

    // The file MUST still exist — that's the whole fix.
    expect(existsSync(stateFile)).toBe(true);
    // Contents unchanged too — no accidental rewrite.
    const raw = await readFile(stateFile, 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      pid: 12345,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });
  });

  it('sends SIGTERM to the recorded pid', async () => {
    await writeState({
      pid: 99999,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });

    await shutdownGatewayOnQuit(tmpDir);

    expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM');
  });

  it('is a no-op when there is no existing gateway state', async () => {
    // No state file written — function should return cleanly.
    await expect(shutdownGatewayOnQuit(tmpDir)).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
    // Still no file afterwards.
    expect(existsSync(stateFile)).toBe(false);
  });

  it('swallows ESRCH from process.kill when the pid is already dead', async () => {
    killSpy.mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    await writeState({
      pid: 123,
      startedAt: '2026-01-01T00:00:00Z',
      port: 9100,
      channelPort: 9101,
    });

    // Must not throw — the handler treats "already dead" as normal.
    await expect(shutdownGatewayOnQuit(tmpDir)).resolves.toBeUndefined();

    // And the file is still there — this is the behavior we care about.
    expect(existsSync(stateFile)).toBe(true);
  });
});

describe('isSetupConfigured', () => {
  it('true when setupCompletedAt is present', () => {
    expect(isSetupConfigured({ setupCompletedAt: '2026-06-21T00:00:00.000Z' }, false)).toBe(true);
  });

  it('true when legacy gateway-state.json exists', () => {
    expect(isSetupConfigured({}, true)).toBe(true);
  });

  it('false when neither flag nor legacy file', () => {
    expect(isSetupConfigured({}, false)).toBe(false);
  });
});

describe('resolveSetupStatus', () => {
  const healthyClient = { listCredentials: async () => ['anthropic-api-key:default'] };

  it('returns needs-setup when not configured and does not touch the gateway', async () => {
    const ensureHealthyClient = vi.fn();
    const result = await resolveSetupStatus({
      isConfigured: async () => false,
      ensureHealthyClient,
      markSetupCompleted: vi.fn(),
    });
    expect(result).toEqual({ state: 'needs-setup' });
    expect(ensureHealthyClient).not.toHaveBeenCalled();
  });

  it('returns ready and marks complete when configured + healthy + has creds', async () => {
    const markSetupCompleted = vi.fn().mockResolvedValue(undefined);
    const result = await resolveSetupStatus({
      isConfigured: async () => true,
      ensureHealthyClient: async () => healthyClient,
      markSetupCompleted,
    });
    expect(result).toEqual({ state: 'ready' });
    expect(markSetupCompleted).toHaveBeenCalledOnce();
  });

  it('returns needs-setup when configured + healthy but no credentials', async () => {
    const result = await resolveSetupStatus({
      isConfigured: async () => true,
      ensureHealthyClient: async () => ({ listCredentials: async () => [] }),
      markSetupCompleted: vi.fn(),
    });
    expect(result).toEqual({ state: 'needs-setup' });
  });

  it('returns gateway-failed with the error message when the client throws', async () => {
    const result = await resolveSetupStatus({
      isConfigured: async () => true,
      ensureHealthyClient: async () => {
        throw new Error('Gateway failed to start within 10s');
      },
      markSetupCompleted: vi.fn(),
    });
    expect(result).toEqual({
      state: 'gateway-failed',
      error: 'Gateway failed to start within 10s',
    });
  });
});

describe('plugin IPC handlers', () => {
  // These mirror the management-client passthrough handlers registered in
  // registerIpcHandlers. They take an already-resolved ManagementClient so we
  // can assert the real behavior (record unwrapping, argument forwarding)
  // without booting Electron.
  const sampleRecord = {
    name: 'acme',
    status: 'loaded' as const,
    enabled: true,
    trusted: false,
    activated: ['skills'],
    noop: [],
  };

  it('pluginsListHandler unwraps the { records } envelope', async () => {
    const client = {
      pluginsList: vi.fn().mockResolvedValue({ records: [sampleRecord] }),
    };
    const result = await pluginsListHandler(client);
    expect(client.pluginsList).toHaveBeenCalledOnce();
    expect(result).toEqual([sampleRecord]);
  });

  it('pluginSetStateHandler forwards (name, patch) and returns the record', async () => {
    const updated = { ...sampleRecord, trusted: true };
    const client = { pluginSetState: vi.fn().mockResolvedValue(updated) };
    const patch = { trusted: true };
    const result = await pluginSetStateHandler(client, 'acme', patch);
    expect(client.pluginSetState).toHaveBeenCalledWith('acme', patch);
    expect(result).toBe(updated);
  });

  it('pluginInstallHandler forwards req.source and req.name', async () => {
    const installed = {
      name: 'acme',
      location: '/data/plugins/acme',
      scanVerdict: 'safe' as const,
      scanReasons: [],
      source: 'git:acme/acme',
    };
    const client = { pluginInstall: vi.fn().mockResolvedValue(installed) };
    const result = await pluginInstallHandler(client, {
      source: 'git:acme/acme',
      name: 'override',
    });
    expect(client.pluginInstall).toHaveBeenCalledWith('git:acme/acme', 'override');
    expect(result).toBe(installed);
  });

  it('pluginInstallHandler passes undefined name when omitted', async () => {
    const client = { pluginInstall: vi.fn().mockResolvedValue({}) };
    await pluginInstallHandler(client, { source: 'git:acme/acme' });
    expect(client.pluginInstall).toHaveBeenCalledWith('git:acme/acme', undefined);
  });

  it('pluginRemoveHandler calls pluginRemove(name)', async () => {
    const client = {
      pluginRemove: vi.fn().mockResolvedValue({ ok: true, path: '/data/plugins/acme' }),
    };
    const result = await pluginRemoveHandler(client, 'acme');
    expect(client.pluginRemove).toHaveBeenCalledWith('acme');
    expect(result).toEqual({ ok: true, path: '/data/plugins/acme' });
  });

  it('pluginReloadHandler calls pluginReload()', async () => {
    const client = {
      pluginReload: vi.fn().mockResolvedValue({ ok: true, reloadedAt: '2026-06-21T00:00:00Z' }),
    };
    const result = await pluginReloadHandler(client);
    expect(client.pluginReload).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, reloadedAt: '2026-06-21T00:00:00Z' });
  });
});
