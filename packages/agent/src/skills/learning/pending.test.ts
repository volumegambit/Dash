import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanSkillsDirectory } from '../scanner.js';
import {
  PENDING_DIRNAME,
  listPending,
  readPending,
  removePending,
  stagePending,
} from './pending.js';
import type { LessonDelta } from './types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dash-pending-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DELTAS: LessonDelta[] = [
  { op: 'add', skill: 'build-lessons', text: 'Re-run the generator first.' },
];

describe('stagePending / readPending', () => {
  it('round-trips a staged proposal', async () => {
    await stagePending(dir, { id: 'abc123', conversationId: 'c1', deltas: DELTAS });

    const read = await readPending(dir, 'abc123');

    expect(read).toMatchObject({ id: 'abc123', conversationId: 'c1', deltas: DELTAS });
    expect(read?.createdAt).toBeTruthy();
  });

  it('returns null for an unknown id', async () => {
    expect(await readPending(dir, 'nope')).toBeNull();
  });

  it('rejects an id that would escape the pending directory', async () => {
    await expect(
      stagePending(dir, { id: '../escape', conversationId: 'c', deltas: DELTAS }),
    ).rejects.toThrow(/invalid pending id/i);

    expect(await readPending(dir, '../escape')).toBeNull();
    expect(await removePending(dir, '../escape')).toBe(false);
  });

  it('drops malformed deltas when reading', async () => {
    await mkdir(join(dir, PENDING_DIRNAME), { recursive: true });
    await writeFile(
      join(dir, PENDING_DIRNAME, 'mixed.json'),
      JSON.stringify({
        id: 'mixed',
        createdAt: '2026-09-06T00:00:00.000Z',
        conversationId: 'c',
        deltas: [DELTAS[0], { op: 'nonsense' }, { op: 'helpful', skill: 's' }],
      }),
    );

    expect((await readPending(dir, 'mixed'))?.deltas).toEqual(DELTAS);
  });

  it('returns null for an unparseable file rather than throwing', async () => {
    await mkdir(join(dir, PENDING_DIRNAME), { recursive: true });
    await writeFile(join(dir, PENDING_DIRNAME, 'broken.json'), '{ not json');

    expect(await readPending(dir, 'broken')).toBeNull();
  });
});

describe('listPending', () => {
  it('lists staged proposals oldest first', async () => {
    await stagePending(dir, {
      id: 'second',
      conversationId: 'c',
      deltas: DELTAS,
      createdAt: '2026-09-06T10:00:00.000Z',
    });
    await stagePending(dir, {
      id: 'first',
      conversationId: 'c',
      deltas: DELTAS,
      createdAt: '2026-09-06T09:00:00.000Z',
    });

    expect((await listPending(dir)).map((p) => p.id)).toEqual(['first', 'second']);
  });

  it('is empty when nothing has been staged', async () => {
    expect(await listPending(dir)).toEqual([]);
  });
});

describe('removePending', () => {
  it('removes a staged proposal', async () => {
    await stagePending(dir, { id: 'abc123', conversationId: 'c', deltas: DELTAS });

    expect(await removePending(dir, 'abc123')).toBe(true);
    expect(await readPending(dir, 'abc123')).toBeNull();
    expect(await removePending(dir, 'abc123')).toBe(false);
  });
});

describe('the staging directory is not mistaken for a skill', () => {
  it('is invisible to skill discovery', async () => {
    await stagePending(dir, { id: 'abc123', conversationId: 'c', deltas: DELTAS });

    expect(await scanSkillsDirectory(dir, 'managed')).toEqual([]);
    expect(existsSync(join(dir, PENDING_DIRNAME))).toBe(true);
  });
});
