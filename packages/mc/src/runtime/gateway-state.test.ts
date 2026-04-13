import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayStateStore } from './gateway-state.js';

describe('GatewayStateStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gw-state-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('returns null when no state file exists', async () => {
    const store = new GatewayStateStore(tmpDir);
    expect(await store.read()).toBeNull();
  });

  it('writes and reads back state', async () => {
    const store = new GatewayStateStore(tmpDir);
    const state = {
      pid: 12345,
      startedAt: '2026-03-08T00:00:00Z',
      port: 9300,
      channelPort: 9301,
    };
    await store.write(state);
    const read = await store.read();
    expect(read).toEqual(state);
  });

  it('read() returns null on malformed JSON', async () => {
    const store = new GatewayStateStore(tmpDir);
    const { writeFile } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');
    await writeFile(pathJoin(tmpDir, 'gateway-state.json'), 'not-json');
    expect(await store.read()).toBeNull();
  });

  it('clear() removes the state file', async () => {
    const store = new GatewayStateStore(tmpDir);
    await store.write({ pid: 1, startedAt: 'x', port: 9300, channelPort: 9301 });
    await store.clear();
    expect(await store.read()).toBeNull();
  });

  it('clear() does not throw when file does not exist', async () => {
    const store = new GatewayStateStore(tmpDir);
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('read() ignores unknown fields in the state file', async () => {
    // Forward/back-compat: extra fields (e.g. a future schema
    // addition, a stale file from an older version) are silently
    // dropped rather than breaking parsing.
    const store = new GatewayStateStore(tmpDir);
    const { writeFile } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');
    await writeFile(
      pathJoin(tmpDir, 'gateway-state.json'),
      JSON.stringify({
        pid: 12345,
        startedAt: '2026-03-08T00:00:00Z',
        port: 9300,
        channelPort: 9301,
        someUnknownField: 'ignored',
        anotherOne: 42,
      }),
    );
    const read = await store.read();
    expect(read).toEqual({
      pid: 12345,
      startedAt: '2026-03-08T00:00:00Z',
      port: 9300,
      channelPort: 9301,
    });
  });

  it('write() strips extra fields even if callers pass them (TypeScript-evasion safety)', async () => {
    const store = new GatewayStateStore(tmpDir);
    await store.write({
      pid: 1,
      startedAt: 'x',
      port: 9300,
      channelPort: 9301,
      // biome-ignore lint/suspicious/noExplicitAny: verifying runtime strip
      ...({ unexpectedField: 'should-not-persist' } as any),
    });
    const { readFile } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');
    const raw = await readFile(pathJoin(tmpDir, 'gateway-state.json'), 'utf-8');
    expect(raw).not.toContain('should-not-persist');
    expect(raw).not.toContain('unexpectedField');
  });
});
