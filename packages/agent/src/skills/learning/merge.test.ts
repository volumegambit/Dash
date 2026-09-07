import { describe, expect, it } from 'vitest';
import { applyDeltasToBook, lessonId, mergeDeltas, normaliseLessonText } from './merge.js';
import { LESSON_LIMITS, type Lesson, type LessonBook, type LessonDelta } from './types.js';

const TODAY = '2026-09-06';

function book(
  skill: string,
  bullets: Lesson[] = [],
  retired: LessonBook['retired'] = [],
): LessonBook {
  return { version: 1, skill, description: 'd', augments: [], bullets, retired };
}

function lesson(text: string, over: Partial<Lesson> = {}): Lesson {
  return {
    id: lessonId(text),
    text,
    helpful: 0,
    harmful: 0,
    createdAt: '2026-01-01',
    lastTouchedAt: '2026-01-01',
    ...over,
  };
}

describe('normaliseLessonText', () => {
  it('ignores case, punctuation and whitespace differences', () => {
    expect(normaliseLessonText('Re-run  the generator!')).toBe(
      normaliseLessonText('re run the GENERATOR'),
    );
  });

  it('does not collapse genuinely different lessons', () => {
    expect(normaliseLessonText('run the generator')).not.toBe(
      normaliseLessonText('skip the generator'),
    );
  });
});

describe('lessonId', () => {
  it('is stable and derived from normalised text', () => {
    expect(lessonId('Run the generator.')).toBe(lessonId('run  the generator'));
    expect(lessonId('a')).toHaveLength(6);
  });
});

describe('rule 3 — add appends a new lesson', () => {
  it('appends with zeroed counters and today as both dates', () => {
    const result = applyDeltasToBook(
      book('s'),
      [{ op: 'add', skill: 's', text: 'Run the generator first.' }],
      { today: TODAY },
    );

    expect(result.book.bullets).toHaveLength(1);
    expect(result.book.bullets[0]).toMatchObject({
      text: 'Run the generator first.',
      helpful: 0,
      harmful: 0,
      createdAt: TODAY,
      lastTouchedAt: TODAY,
    });
    expect(result.applied).toBe(1);
  });
});

describe('rule 2 — a restated lesson counts as helpful, not as a duplicate', () => {
  it('increments the existing lesson instead of appending', () => {
    const existing = lesson('Run the generator first.');
    const result = applyDeltasToBook(
      book('s', [existing]),
      [{ op: 'add', skill: 's', text: 'run the GENERATOR first' }],
      { today: TODAY },
    );

    expect(result.book.bullets).toHaveLength(1);
    expect(result.book.bullets[0].helpful).toBe(1);
    expect(result.book.bullets[0].lastTouchedAt).toBe(TODAY);
  });
});

describe('rule 4 — helpful / harmful increment', () => {
  it('increments helpful and stamps lastTouchedAt', () => {
    const existing = lesson('x');
    const result = applyDeltasToBook(
      book('s', [existing]),
      [{ op: 'helpful', skill: 's', id: existing.id }],
      { today: TODAY },
    );

    expect(result.book.bullets[0].helpful).toBe(1);
    expect(result.book.bullets[0].harmful).toBe(0);
    expect(result.book.bullets[0].lastTouchedAt).toBe(TODAY);
  });

  it('increments harmful', () => {
    const existing = lesson('x');
    const result = applyDeltasToBook(
      book('s', [existing]),
      [{ op: 'harmful', skill: 's', id: existing.id, reason: 'wrong' }],
      { today: TODAY },
    );

    expect(result.book.bullets[0].harmful).toBe(1);
  });

  it('is a no-op for an unknown id and records it as dropped', () => {
    const result = applyDeltasToBook(
      book('s', [lesson('x')]),
      [{ op: 'helpful', skill: 's', id: 'nope00' }],
      { today: TODAY },
    );

    expect(result.book.bullets[0].helpful).toBe(0);
    expect(result.applied).toBe(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/unknown lesson/i);
  });
});

describe('rule 5 — a lesson that is only ever harmful retires', () => {
  it('retires on the third harmful mark when never helpful', () => {
    const existing = lesson('x', { harmful: 2 });
    const result = applyDeltasToBook(
      book('s', [existing]),
      [{ op: 'harmful', skill: 's', id: existing.id }],
      { today: TODAY },
    );

    expect(result.book.bullets).toHaveLength(0);
    expect(result.book.retired).toHaveLength(1);
    expect(result.book.retired[0]).toMatchObject({
      id: existing.id,
      retiredReason: 'harmful',
      retiredAt: TODAY,
    });
  });

  it('does not retire at two harmful marks', () => {
    const existing = lesson('x', { harmful: 1 });
    const result = applyDeltasToBook(
      book('s', [existing]),
      [{ op: 'harmful', skill: 's', id: existing.id }],
      { today: TODAY },
    );

    expect(result.book.bullets).toHaveLength(1);
    expect(result.book.retired).toHaveLength(0);
  });

  it('keeps a lesson that has ever been helpful, however harmful it becomes', () => {
    const existing = lesson('x', { helpful: 1, harmful: 5 });
    const result = applyDeltasToBook(
      book('s', [existing]),
      [{ op: 'harmful', skill: 's', id: existing.id }],
      { today: TODAY },
    );

    expect(result.book.bullets).toHaveLength(1);
    expect(result.book.retired).toHaveLength(0);
  });
});

describe('rule 9 — a retired lesson does not come back', () => {
  it('drops an add whose text matches an already-retired lesson', () => {
    const dead = { ...lesson('bad advice'), retiredAt: TODAY, retiredReason: 'harmful' as const };
    const result = applyDeltasToBook(
      book('s', [], [dead]),
      [{ op: 'add', skill: 's', text: 'Bad advice!' }],
      { today: TODAY },
    );

    expect(result.book.bullets).toHaveLength(0);
    expect(result.applied).toBe(0);
    expect(result.dropped[0].reason).toMatch(/retired/i);
  });
});

describe('rule 6 — the book caps at maxLessonsPerSkill', () => {
  it('retires the least valuable lesson when full', () => {
    const bullets = Array.from({ length: LESSON_LIMITS.maxLessonsPerSkill }, (_, i) =>
      lesson(`lesson number ${i}`, { helpful: 5 }),
    );
    // The one clear loser: net score -2 against everyone else's +5.
    bullets[7] = lesson('the weakest lesson', { helpful: 0, harmful: 2 });

    const result = applyDeltasToBook(
      book('s', bullets),
      [{ op: 'add', skill: 's', text: 'a brand new lesson' }],
      { today: TODAY },
    );

    expect(result.book.bullets).toHaveLength(LESSON_LIMITS.maxLessonsPerSkill);
    expect(result.book.bullets.map((b) => b.text)).toContain('a brand new lesson');
    expect(result.book.bullets.map((b) => b.text)).not.toContain('the weakest lesson');
    expect(result.book.retired[0]).toMatchObject({
      text: 'the weakest lesson',
      retiredReason: 'capacity',
    });
  });

  it('breaks a score tie by retiring the least recently touched', () => {
    const bullets = Array.from({ length: LESSON_LIMITS.maxLessonsPerSkill }, (_, i) =>
      lesson(`lesson number ${i}`, { helpful: 1, lastTouchedAt: '2026-05-05' }),
    );
    bullets[3] = lesson('stalest lesson', { helpful: 1, lastTouchedAt: '2020-01-01' });

    const result = applyDeltasToBook(
      book('s', bullets),
      [{ op: 'add', skill: 's', text: 'a brand new lesson' }],
      { today: TODAY },
    );

    expect(result.book.retired[0]).toMatchObject({
      text: 'stalest lesson',
      retiredReason: 'capacity',
    });
  });
});

describe('mergeDeltas — across books', () => {
  it('rule 1 — an add naming an unknown skill creates a book', () => {
    const result = mergeDeltas(
      [],
      [
        {
          op: 'add',
          skill: 'debugging-builds',
          text: 'Run the generator first.',
          description: 'Use when a build fails',
          augments: ['dash-dev'],
        },
      ],
      { today: TODAY },
    );

    expect(result.created).toEqual(['debugging-builds']);
    expect(result.books).toHaveLength(1);
    expect(result.books[0]).toMatchObject({
      skill: 'debugging-builds',
      description: 'Use when a build fails',
      augments: ['dash-dev'],
    });
    expect(result.books[0].bullets).toHaveLength(1);
  });

  it('routes deltas to the right book and returns only changed books', () => {
    const a = book('alpha', [lesson('a lesson')]);
    const b = book('beta', [lesson('b lesson')]);

    const result = mergeDeltas([a, b], [{ op: 'add', skill: 'beta', text: 'new b lesson' }], {
      today: TODAY,
    });

    expect(result.books.map((x) => x.skill)).toEqual(['beta']);
    expect(result.books[0].bullets).toHaveLength(2);
  });

  it('rule 7 — drops an add that would create a skill past the cap', () => {
    const existing = Array.from({ length: LESSON_LIMITS.maxSkills }, (_, i) =>
      book(`skill-${i}`, [lesson(`lesson ${i}`)]),
    );

    const result = mergeDeltas(existing, [{ op: 'add', skill: 'one-too-many', text: 'nope' }], {
      today: TODAY,
    });

    expect(result.created).toEqual([]);
    expect(result.books).toEqual([]);
    expect(result.dropped[0].reason).toMatch(/limit/i);
  });

  it('still accepts lessons for existing books when at the skill cap', () => {
    const existing = Array.from({ length: LESSON_LIMITS.maxSkills }, (_, i) =>
      book(`skill-${i}`, [lesson(`lesson ${i}`)]),
    );

    const result = mergeDeltas(
      existing,
      [{ op: 'add', skill: 'skill-0', text: 'another lesson' }],
      {
        today: TODAY,
      },
    );

    expect(result.books).toHaveLength(1);
    expect(result.books[0].bullets).toHaveLength(2);
  });

  it('drops a delta naming an invalid skill name before it reaches the filesystem', () => {
    const result = mergeDeltas([], [{ op: 'add', skill: '../escape', text: 'x' }], {
      today: TODAY,
    });

    expect(result.created).toEqual([]);
    expect(result.dropped[0].reason).toMatch(/invalid skill name/i);
  });

  it('drops an over-long lesson rather than truncating it mid-sentence', () => {
    const result = mergeDeltas(
      [],
      [
        {
          op: 'add',
          skill: 'a-skill',
          text: 'x'.repeat(LESSON_LIMITS.maxLessonChars + 1),
          description: 'd',
        },
      ],
      { today: TODAY },
    );

    expect(result.created).toEqual([]);
    expect(result.dropped[0].reason).toMatch(/too long/i);
  });

  it('returns nothing changed for an empty delta list', () => {
    const result = mergeDeltas([book('a', [lesson('x')])], [], { today: TODAY });
    expect(result.books).toEqual([]);
    expect(result.applied).toBe(0);
  });

  it('ignores a delta for a book that does not exist and was not created', () => {
    const result = mergeDeltas([], [{ op: 'helpful', skill: 'ghost', id: 'abc123' }], {
      today: TODAY,
    });

    expect(result.books).toEqual([]);
    expect(result.dropped[0].reason).toMatch(/no lesson book/i);
  });
});

describe('immutability', () => {
  it('never mutates the input book', () => {
    const original = book('s', [lesson('x')]);
    const snapshot = structuredClone(original);

    applyDeltasToBook(original, [{ op: 'add', skill: 's', text: 'y' }], { today: TODAY });

    expect(original).toEqual(snapshot);
  });
});

describe('delta ordering', () => {
  it('applies deltas in order so an add can be marked by a later delta', () => {
    const text = 'a fresh lesson';
    const deltas: LessonDelta[] = [
      { op: 'add', skill: 's', text },
      { op: 'helpful', skill: 's', id: lessonId(text) },
    ];

    const result = applyDeltasToBook(book('s'), deltas, { today: TODAY });

    expect(result.book.bullets[0].helpful).toBe(1);
  });
});

describe('reserved skill names', () => {
  it('drops an add that would shadow an existing skill with no lesson book', () => {
    // `deploy-staging` is a real skill (user-authored, plugin, or installed).
    // Writing a lesson book onto it would replace its instructions; creating a
    // managed one of the same name would shadow it in discovery.
    const result = mergeDeltas([], [{ op: 'add', skill: 'deploy-staging', text: 'x' }], {
      today: TODAY,
      reservedNames: ['deploy-staging'],
    });

    expect(result.created).toEqual([]);
    expect(result.books).toEqual([]);
    expect(result.dropped[0].reason).toMatch(/existing skill/i);
  });

  it('still accepts lessons for a learned skill that shares the name', () => {
    // Once a book exists for that name it IS the learned skill, so reserving
    // the name must not freeze it out of further lessons.
    const existing = book('deploy-lessons', [lesson('first lesson')]);

    const result = mergeDeltas(
      [existing],
      [{ op: 'add', skill: 'deploy-lessons', text: 'second' }],
      {
        today: TODAY,
        reservedNames: ['deploy-lessons'],
      },
    );

    expect(result.books).toHaveLength(1);
    expect(result.books[0].bullets).toHaveLength(2);
  });

  it('is unaffected when no names are reserved', () => {
    const result = mergeDeltas([], [{ op: 'add', skill: 'anything', text: 'x' }], { today: TODAY });
    expect(result.created).toEqual(['anything']);
  });
});
