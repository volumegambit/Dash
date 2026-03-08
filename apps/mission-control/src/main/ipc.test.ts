import { describe, expect, it, vi } from 'vitest';

// We need to import makePackagedSpawner — it doesn't exist yet, so this will fail
// Import it from ipc.ts after you implement it
import { makePackagedSpawner } from './ipc.js';

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
