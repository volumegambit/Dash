import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOKS_FILE, readHooksJson, validateHooksJson } from './hooks-manifest.js';

describe('validateHooksJson', () => {
  it('parses the real Claude Code format (events under a top-level "hooks" key)', () => {
    const cfg = validateHooksJson({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'lint', timeout: 5 },
              { type: 'command', command: 'check' },
            ],
          },
        ],
      },
    });
    expect(cfg.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'echo start' }] }]);
    expect(cfg.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'lint', timeout: 5 },
          { type: 'command', command: 'check' },
        ],
      },
    ]);
  });

  it('ignores sibling keys (description, disableAllHooks)', () => {
    const cfg = validateHooksJson({
      description: 'my hooks',
      disableAllHooks: false,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    });
    expect(cfg.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'x' }] }]);
    expect((cfg as Record<string, unknown>).description).toBeUndefined();
    expect((cfg as Record<string, unknown>).disableAllHooks).toBeUndefined();
  });

  it('returns {} when there is no "hooks" key', () => {
    expect(validateHooksJson({ description: 'just metadata' })).toEqual({});
  });

  it('preserves unknown event keys (engine ignores unmapped ones)', () => {
    const cfg = validateHooksJson({
      hooks: { FutureEvent: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    });
    expect((cfg as Record<string, unknown>).FutureEvent).toEqual([
      { hooks: [{ type: 'command', command: 'x' }] },
    ]);
  });

  it('does not leak prototype-polluting keys', () => {
    const cfg = validateHooksJson(
      JSON.parse('{"hooks":{"__proto__":{"polluted":true},"SessionStart":[{"hooks":[]}]}}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(cfg.SessionStart).toEqual([{ hooks: [] }]);
  });

  it('throws when the root is not an object', () => {
    expect(() => validateHooksJson([])).toThrow(/object/);
    expect(() => validateHooksJson(null)).toThrow(/object/);
    expect(() => validateHooksJson('x')).toThrow(/object/);
  });

  it('throws when "hooks" is present but not an object', () => {
    expect(() => validateHooksJson({ hooks: [] })).toThrow(/'hooks'/);
    expect(() => validateHooksJson({ hooks: 'x' })).toThrow(/'hooks'/);
  });

  it('throws when an event does not map to an array of groups', () => {
    expect(() => validateHooksJson({ hooks: { SessionStart: {} } })).toThrow(/array/);
  });

  it('throws when a group is missing its hooks array', () => {
    expect(() => validateHooksJson({ hooks: { SessionStart: [{ matcher: 'x' }] } })).toThrow(
      /hooks/,
    );
  });

  it('throws when a command is missing a non-empty command string', () => {
    expect(() =>
      validateHooksJson({ hooks: { SessionStart: [{ hooks: [{ type: 'command' }] }] } }),
    ).toThrow(/command/);
    expect(() =>
      validateHooksJson({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '' }] }] },
      }),
    ).toThrow(/command/);
  });

  it('throws when a command has the wrong type', () => {
    expect(() =>
      validateHooksJson({
        hooks: { SessionStart: [{ hooks: [{ type: 'shell', command: 'x' }] }] },
      }),
    ).toThrow(/command/);
  });

  it('throws when timeout is not a number', () => {
    expect(() =>
      validateHooksJson({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x', timeout: 'soon' }] }] },
      }),
    ).toThrow(/timeout/);
  });
});

describe('readHooksJson', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-hooks-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns {} when the file is absent', async () => {
    expect(await readHooksJson(dir)).toEqual({});
  });

  it('reads and validates a real-format <dir>/hooks/hooks.json', async () => {
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, HOOKS_FILE),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt', timeout: 2 }] },
          ],
        },
      }),
    );
    const cfg = await readHooksJson(dir);
    expect(cfg.PostToolUse).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt', timeout: 2 }] },
    ]);
  });

  it('throws on malformed JSON', async () => {
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, HOOKS_FILE), '{ not json');
    await expect(readHooksJson(dir)).rejects.toThrow(/JSON/);
  });

  it('throws on a structurally invalid config', async () => {
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, HOOKS_FILE), JSON.stringify({ hooks: { SessionStart: {} } }));
    await expect(readHooksJson(dir)).rejects.toThrow(/array/);
  });
});
