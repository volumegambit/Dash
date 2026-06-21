import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHookEngine } from './hook-engine.js';
import type { HookConfigEntry } from './types.js';

// Mock node:child_process so a single test can make spawn() throw synchronously
// (simulating EMFILE / bad cwd). By default it delegates to the real spawn, so
// every other test exercises real child processes. `spawnThrowsOnce` flips the
// next spawn() call to a synchronous throw.
let spawnThrowsOnce = false;
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnThrowsOnce) {
        spawnThrowsOnce = false;
        throw new Error('synchronous spawn boom');
      }
      return actual.spawn(...args);
    },
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, '..', 'test', 'fixtures', 'hooks');
const fix = (name: string) => join(FIX, name);

/** Build a single-plugin hookConfig entry. */
function entry(
  config: HookConfigEntry['config'],
  pluginName = 'p',
  pluginRoot = FIX,
): HookConfigEntry {
  return { pluginName, pluginRoot, config };
}

/** A `node <fixture>` command (extra args appended). */
function cmd(script: string, ...args: string[]): { type: 'command'; command: string } {
  return {
    type: 'command',
    command: `node ${fix(script)}${args.length ? ` ${args.join(' ')}` : ''}`,
  };
}

function makeLogger() {
  const warnings: string[] = [];
  return { warnings, logger: { warn: (m: string) => warnings.push(m) } };
}

describe('createHookEngine — hasHooks', () => {
  it('is false when no configs / empty configs', () => {
    expect(createHookEngine([]).hasHooks).toBe(false);
    expect(createHookEngine([entry({})]).hasHooks).toBe(false);
  });

  it('is true when at least one group exists', () => {
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('allow.js')] }] })]);
    expect(e.hasHooks).toBe(true);
  });
});

describe('runPreToolUse', () => {
  it('deny → { block: true, reason }', async () => {
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('deny.js')] }] })]);
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: { command: 'ls' } });
    expect(d.block).toBe(true);
    expect(d.reason).toBe('nope');
  });

  it('exit 2 → blocks with stderr reason', async () => {
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('block2.js')] }] })]);
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: {} });
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/block2/);
  });

  it('modify → { block: false, updatedInput }', async () => {
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('modify.js')] }] })]);
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: { command: 'ls' } });
    expect(d.block).toBe(false);
    expect(d.updatedInput).toEqual({ command: 'ls', modified: true });
  });

  it('threads updatedInput from one hook into the next', async () => {
    const { warnings, logger } = makeLogger();
    const e = createHookEngine(
      [entry({ PreToolUse: [{ hooks: [cmd('modify.js'), cmd('deny.js')] }] })],
      { logger },
    );
    // modify runs first (adds modified:true); deny runs second and blocks.
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: { command: 'ls' } });
    expect(d.block).toBe(true);
    expect(d.reason).toBe('nope');
    expect(warnings).toEqual([]);
  });

  it('matcher filters by tool name — Bash hook does not fire for Read', async () => {
    const e = createHookEngine([
      entry({ PreToolUse: [{ matcher: 'Bash', hooks: [cmd('deny.js')] }] }),
    ]);
    const denied = await e.runPreToolUse({ toolName: 'Bash', toolInput: {} });
    expect(denied.block).toBe(true);
    const allowed = await e.runPreToolUse({ toolName: 'Read', toolInput: {} });
    expect(allowed.block).toBe(false);
  });

  it('matcher supports pipe-separated exact list', async () => {
    const e = createHookEngine([
      entry({ PreToolUse: [{ matcher: 'Edit|Write', hooks: [cmd('deny.js')] }] }),
    ]);
    expect((await e.runPreToolUse({ toolName: 'Write', toolInput: {} })).block).toBe(true);
    expect((await e.runPreToolUse({ toolName: 'Read', toolInput: {} })).block).toBe(false);
  });

  it('matcher supports a regex', async () => {
    const e = createHookEngine([
      entry({ PreToolUse: [{ matcher: '^mcp__.*', hooks: [cmd('deny.js')] }] }),
    ]);
    expect((await e.runPreToolUse({ toolName: 'mcp__foo__bar', toolInput: {} })).block).toBe(true);
    expect((await e.runPreToolUse({ toolName: 'Bash', toolInput: {} })).block).toBe(false);
  });

  it('boom.js (exit 1) fails open and logs', async () => {
    const { warnings, logger } = makeLogger();
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('boom.js')] }] })], { logger });
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: {} });
    expect(d.block).toBe(false);
    expect(d.updatedInput).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('slow.js (timeout) is killed, fails open and logs', async () => {
    const { warnings, logger } = makeLogger();
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('slow.js')] }] })], {
      logger,
      defaultTimeoutMs: 300,
    });
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: {} });
    expect(d.block).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('a failing hook does not stop a later blocking hook', async () => {
    const { logger } = makeLogger();
    const e = createHookEngine(
      [entry({ PreToolUse: [{ hooks: [cmd('boom.js'), cmd('deny.js')] }] })],
      { logger },
    );
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: {} });
    expect(d.block).toBe(true);
  });
});

describe('synchronous spawn failure (TDZ fail-open)', () => {
  // A synchronous throw from spawn() (e.g. EMFILE / bad cwd) hits the catch in
  // runOne while the timeout `timer` was still in its temporal dead zone, which
  // raised a ReferenceError and REJECTED the promise instead of failing open.
  // These assert the engine resolves to the neutral outcome, never throws.
  afterEach(() => {
    spawnThrowsOnce = false;
  });

  it('runPreToolUse resolves NEUTRAL when spawn throws synchronously', async () => {
    spawnThrowsOnce = true;
    const { warnings, logger } = makeLogger();
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('deny.js')] }] })], { logger });
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: {} });
    expect(d.block).toBe(false);
    expect(d.updatedInput).toBeUndefined();
    expect(warnings.some((w) => /spawn failed/.test(w))).toBe(true);
  });

  it('runUserPromptSubmit resolves NEUTRAL when spawn throws synchronously', async () => {
    spawnThrowsOnce = true;
    const e = createHookEngine([entry({ UserPromptSubmit: [{ hooks: [cmd('addctx.js', 'X')] }] })]);
    const d = await e.runUserPromptSubmit({ prompt: 'hi' });
    expect(d.block).toBe(false);
    expect(d.additionalContext).toBeUndefined();
  });
});

describe('runaway hook output (OOM cap)', () => {
  it('a hook that floods stdout past the cap is killed and fails open', async () => {
    const { warnings, logger } = makeLogger();
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('flood.js')] }] })], {
      logger,
      defaultTimeoutMs: 30_000, // generous: the CAP must fire well before this.
    });
    const start = Date.now();
    const d = await e.runPreToolUse({ toolName: 'Bash', toolInput: {} });
    // Must not hang until the timeout — the output cap kills it quickly.
    expect(Date.now() - start).toBeLessThan(20_000);
    expect(d.block).toBe(false);
    expect(warnings.some((w) => /output/i.test(w))).toBe(true);
  }, 25_000);
});

describe('runPostToolUse', () => {
  it('blocks via top-level decision:block JSON output', async () => {
    const e = createHookEngine([entry({ PostToolUse: [{ hooks: [cmd('decision-block.js')] }] })]);
    const d = await e.runPostToolUse({ toolName: 'Bash', toolInput: {}, toolResponse: 'ok' });
    expect(d.block).toBe(true);
    expect(d.reason).toBe('top-level block');
  });

  it('blocks via exit 2 with stderr reason', async () => {
    const e = createHookEngine([entry({ PostToolUse: [{ hooks: [cmd('block2.js')] }] })]);
    const d = await e.runPostToolUse({ toolName: 'Bash', toolInput: {}, toolResponse: 'ok' });
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/block2/);
  });

  it('concatenates additionalContext across two hooks', async () => {
    const e = createHookEngine([
      entry({ PostToolUse: [{ hooks: [cmd('addctx.js', 'AAA'), cmd('addctx.js', 'BBB')] }] }),
    ]);
    const d = await e.runPostToolUse({
      toolName: 'Bash',
      toolInput: {},
      toolResponse: 'ok',
    });
    expect(d.block).toBe(false);
    expect(d.additionalContext).toContain('AAA');
    expect(d.additionalContext).toContain('BBB');
  });

  it('concatenates additionalContext across two plugins', async () => {
    const e = createHookEngine([
      entry({ PostToolUse: [{ hooks: [cmd('addctx.js', 'P1')] }] }, 'p1'),
      entry({ PostToolUse: [{ hooks: [cmd('addctx.js', 'P2')] }] }, 'p2'),
    ]);
    const d = await e.runPostToolUse({ toolName: 'Bash', toolInput: {}, toolResponse: 'ok' });
    expect(d.additionalContext).toContain('P1');
    expect(d.additionalContext).toContain('P2');
  });
});

describe('runUserPromptSubmit', () => {
  it('emits additionalContext', async () => {
    const e = createHookEngine([
      entry({ UserPromptSubmit: [{ hooks: [cmd('addctx.js', 'PROMPTCTX')] }] }),
    ]);
    const d = await e.runUserPromptSubmit({ prompt: 'hi' });
    expect(d.block).toBe(false);
    expect(d.additionalContext).toContain('PROMPTCTX');
  });

  it('exit 2 blocks', async () => {
    const e = createHookEngine([entry({ UserPromptSubmit: [{ hooks: [cmd('block2.js')] }] })]);
    const d = await e.runUserPromptSubmit({ prompt: 'hi' });
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/block2/);
  });

  it('blocks on a top-level decision:block JSON output (not exit-2)', async () => {
    const e = createHookEngine([
      entry({ UserPromptSubmit: [{ hooks: [cmd('decision-block.js')] }] }),
    ]);
    const d = await e.runUserPromptSubmit({ prompt: 'hi' });
    expect(d.block).toBe(true);
    expect(d.reason).toBe('top-level block');
  });
});

describe('runSessionStart', () => {
  it('matches against source and concatenates additionalContext', async () => {
    const e = createHookEngine([
      entry({ SessionStart: [{ matcher: 'startup', hooks: [cmd('addctx.js', 'SS')] }] }),
    ]);
    const matched = await e.runSessionStart({ source: 'startup' });
    expect(matched.additionalContext).toContain('SS');
    const unmatched = await e.runSessionStart({ source: 'resume' });
    expect(unmatched.additionalContext).toBeUndefined();
  });
});

describe('runStop', () => {
  it('runs Stop hooks (all-match) and returns lifecycle result', async () => {
    const e = createHookEngine([entry({ Stop: [{ hooks: [cmd('addctx.js', 'STOPCTX')] }] })]);
    const d = await e.runStop({});
    expect(d.additionalContext).toContain('STOPCTX');
  });
});

describe('large undrained stdin payloads (async EPIPE fail-open)', () => {
  // A payload comfortably larger than the OS pipe buffer (~64 KB). When the
  // child never reads stdin, the engine's pending stdin.end() write blocks,
  // then emits an async EPIPE once the child closes the read end. Without an
  // error listener on child.stdin, Node escalates that to uncaughtException
  // and crashes the host. These tests assert the run resolves fail-open AND
  // that no uncaughtException/unhandledRejection fires during the run.
  const BIG = 'x'.repeat(200 * 1024); // ~200 KB, well past 64 KB pipe buffer.

  /** Run `fn` while asserting no uncaught error / unhandled rejection fires. */
  async function withNoUncaught<T>(fn: () => Promise<T>): Promise<T> {
    const events: unknown[] = [];
    const onUncaught = (e: unknown) => events.push(e);
    const onUnhandled = (e: unknown) => events.push(e);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await fn();
      // Give a microtask + macrotask gap for any async stdin error to surface.
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toEqual([]);
      return result;
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }
  }

  it('PostToolUse with >64KB toolResponse and a hook that ignores stdin → fail-open, no crash', async () => {
    const { warnings, logger } = makeLogger();
    const e = createHookEngine([entry({ PostToolUse: [{ hooks: [cmd('ignore-stdin.js')] }] })], {
      logger,
    });
    const d = await withNoUncaught(() =>
      e.runPostToolUse({ toolName: 'Write', toolInput: {}, toolResponse: BIG }),
    );
    expect(d.block).toBe(false);
    void warnings; // a swallowed stdin error may or may not log; behavior is what matters.
  });

  it('PreToolUse with >64KB toolInput and a hook that ignores stdin → fail-open, no crash', async () => {
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('ignore-stdin.js')] }] })]);
    const d = await withNoUncaught(() =>
      e.runPreToolUse({ toolName: 'Write', toolInput: { content: BIG } }),
    );
    expect(d.block).toBe(false);
  });

  it('timeout variant: hook ignores stdin and sleeps past timeout with >64KB payload → fail-open, no crash', async () => {
    const { warnings, logger } = makeLogger();
    const e = createHookEngine(
      [entry({ PostToolUse: [{ hooks: [cmd('slow-ignore-stdin.js')] }] })],
      { logger, defaultTimeoutMs: 300 },
    );
    const d = await withNoUncaught(() =>
      e.runPostToolUse({ toolName: 'Write', toolInput: {}, toolResponse: BIG }),
    );
    expect(d.block).toBe(false);
    expect(warnings.length).toBeGreaterThan(0); // timeout is logged.
  });
});

describe('stdin payload shape', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-hookstdin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a Claude Code PreToolUse payload to stdin', async () => {
    const out = join(dir, 'stdin.json');
    const e = createHookEngine([entry({ PreToolUse: [{ hooks: [cmd('echo-stdin.js', out)] }] })]);
    await e.runPreToolUse({
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      sessionId: 'sess-1',
      cwd: dir,
    });
    const payload = JSON.parse(await readFile(out, 'utf8'));
    expect(payload).toMatchObject({
      session_id: 'sess-1',
      cwd: dir,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
  });

  it('writes a Claude Code SessionStart payload with source', async () => {
    const out = join(dir, 'stdin2.json');
    const e = createHookEngine([entry({ SessionStart: [{ hooks: [cmd('echo-stdin.js', out)] }] })]);
    await e.runSessionStart({ sessionId: 'sess-2', cwd: dir, source: 'startup' });
    const payload = JSON.parse(await readFile(out, 'utf8'));
    expect(payload).toMatchObject({
      session_id: 'sess-2',
      cwd: dir,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
  });
});
