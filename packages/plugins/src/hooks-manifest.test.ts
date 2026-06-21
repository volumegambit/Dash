import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOKS_FILE, readHooksJson, validateHooksJson } from './hooks-manifest.js';

describe('validateHooksJson', () => {
  it('parses a valid config (events → groups → commands, incl. matcher + timeout)', () => {
    const cfg = validateHooksJson({
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

  it('preserves unknown event keys (engine ignores unmapped ones)', () => {
    const cfg = validateHooksJson({
      FutureEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
    });
    expect((cfg as Record<string, unknown>).FutureEvent).toEqual([
      { hooks: [{ type: 'command', command: 'x' }] },
    ]);
  });

  it('does not leak prototype-polluting keys', () => {
    const cfg = validateHooksJson(
      JSON.parse('{"__proto__":{"polluted":true},"SessionStart":[{"hooks":[]}]}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(cfg.SessionStart).toEqual([{ hooks: [] }]);
  });

  it('throws when the root is not an object', () => {
    expect(() => validateHooksJson([])).toThrow(/object/);
    expect(() => validateHooksJson(null)).toThrow(/object/);
    expect(() => validateHooksJson('x')).toThrow(/object/);
  });

  it('throws when an event does not map to an array of groups', () => {
    expect(() => validateHooksJson({ SessionStart: {} })).toThrow(/array/);
  });

  it('throws when a group is missing its hooks array', () => {
    expect(() => validateHooksJson({ SessionStart: [{ matcher: 'x' }] })).toThrow(/hooks/);
  });

  it('throws when a command is missing a non-empty command string', () => {
    expect(() => validateHooksJson({ SessionStart: [{ hooks: [{ type: 'command' }] }] })).toThrow(
      /command/,
    );
    expect(() =>
      validateHooksJson({ SessionStart: [{ hooks: [{ type: 'command', command: '' }] }] }),
    ).toThrow(/command/);
  });

  it('throws when a command has the wrong type', () => {
    expect(() =>
      validateHooksJson({ SessionStart: [{ hooks: [{ type: 'shell', command: 'x' }] }] }),
    ).toThrow(/command/);
  });

  it('throws when timeout is not a number', () => {
    expect(() =>
      validateHooksJson({
        SessionStart: [{ hooks: [{ type: 'command', command: 'x', timeout: 'soon' }] }],
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

  it('reads and validates <dir>/hooks/hooks.json', async () => {
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(
      join(dir, HOOKS_FILE),
      JSON.stringify({
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt', timeout: 2 }] },
        ],
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
    await writeFile(join(dir, HOOKS_FILE), JSON.stringify({ SessionStart: {} }));
    await expect(readHooksJson(dir)).rejects.toThrow(/array/);
  });
});
