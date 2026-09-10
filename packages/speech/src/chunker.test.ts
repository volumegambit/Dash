import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SentenceChunker, speakable } from './chunker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures', 'speakable');

/** Pushes `text` into `chunker` one character at a time, collecting every emitted sentence. */
function pushChars(chunker: SentenceChunker, text: string): string[] {
  const emitted: string[] = [];
  for (const ch of text) emitted.push(...chunker.push(ch));
  emitted.push(...chunker.flush());
  return emitted;
}

/** Like `pushChars`, but does not call `flush()` — for inspecting mid-stream emission. */
function pushCharsNoFlush(chunker: SentenceChunker, text: string): string[] {
  const emitted: string[] = [];
  for (const ch of text) emitted.push(...chunker.push(ch));
  return emitted;
}

describe('speakable', () => {
  const names = readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));

  expect(names.length).toBeGreaterThanOrEqual(6);

  for (const name of names) {
    it(`renders ${name}.md to ${name}.txt`, () => {
      const markdown = readFileSync(join(fixturesDir, `${name}.md`), 'utf8');
      const expected = readFileSync(join(fixturesDir, `${name}.txt`), 'utf8').replace(/\n$/, '');
      expect(speakable(markdown)).toBe(expected);
    });
  }
});

describe('SentenceChunker', () => {
  it('emits nothing and flush returns [] when nothing was pushed', () => {
    const chunker = new SentenceChunker();
    expect(chunker.flush()).toEqual([]);
  });

  it('emits a sentence on a blank line between paragraphs', () => {
    const chunker = new SentenceChunker();
    const emitted = [...chunker.push('First paragraph.\n\n'), ...chunker.flush()];
    expect(emitted).toEqual(['First paragraph.']);
  });

  it('emits multiple sentences from one paragraph on punctuation triggers', () => {
    const chunker = new SentenceChunker();
    const emitted = [
      ...chunker.push('First sentence. Second sentence! Third one?\n\n'),
      ...chunker.flush(),
    ];
    expect(emitted).toEqual(['First sentence.', 'Second sentence!', 'Third one?']);
  });

  it('does not split after an abbreviation like "e.g."', () => {
    const chunker = new SentenceChunker();
    const emitted = [
      ...chunker.push('Bring supplies, e.g. rope and a torch, for the hike.\n\n'),
      ...chunker.flush(),
    ];
    expect(emitted).toEqual(['Bring supplies, e.g. rope and a torch, for the hike.']);
  });

  it('does not split a digit-only token from a following digit (reflowed decimal)', () => {
    const chunker = new SentenceChunker();
    const emitted = [...chunker.push('Add 3. 5 more cups of flour.\n\n'), ...chunker.flush()];
    expect(emitted).toEqual(['Add 3. 5 more cups of flour.']);
  });

  // --- Fix round 1: plain-text sentences emit mid-paragraph, while streaming, not just at
  // paragraph end. Block-construct lines (heading/list/blockquote/table) still emit only when
  // their own line completes. A fenced code block still holds everything of its own content
  // until it closes or flush() — but text before/after the fence in the same paragraph is
  // ordinary plain text and follows the plain-text rule. ---

  it('(a) emits each plain sentence as soon as its terminator and following whitespace arrive, with no blank line', () => {
    const chunker = new SentenceChunker();

    // "Hello there." is not yet emittable right at its period — only once
    // the *following whitespace* streams in does the boundary resolve.
    expect(pushCharsNoFlush(chunker, 'Hello there.')).toEqual([]);
    expect(pushCharsNoFlush(chunker, ' ')).toEqual(['Hello there.']);

    // Likewise "How are you?" only resolves on its trailing space, not its "?".
    expect(pushCharsNoFlush(chunker, 'How are you?')).toEqual([]);
    expect(pushCharsNoFlush(chunker, ' ')).toEqual(['How are you?']);

    // The final fragment has no terminator, so nothing more emits until flush().
    const afterThird = pushCharsNoFlush(chunker, 'I am fine');
    expect(afterThird).toEqual([]);

    expect(chunker.flush()).toEqual(['I am fine']);
  });

  it('(b) applies speakable inline transforms (emphasis, links) to each emitted sentence', () => {
    const chunker = new SentenceChunker();

    const afterFirst = pushCharsNoFlush(chunker, '**Bold** start. ');
    expect(afterFirst).toEqual(['Bold start.']);

    const afterSecond = pushCharsNoFlush(chunker, 'Then [a link](http://x) ends. ');
    expect(afterSecond).toEqual(['Then a link ends.']);

    expect(chunker.flush()).toEqual([]);
  });

  it('(c) emits each list item as soon as its line completes, not waiting for the list to end', () => {
    const chunker = new SentenceChunker();

    expect(pushCharsNoFlush(chunker, '- Buy milk\n')).toEqual(['Buy milk.']);
    expect(pushCharsNoFlush(chunker, '- Buy eggs.\n')).toEqual(['Buy eggs.']);
    expect(pushCharsNoFlush(chunker, '- Buy bread\n')).toEqual(['Buy bread.']);

    expect(chunker.flush()).toEqual([]);
  });

  it('holds an open fenced code block until it closes, then emits "Code block omitted."', () => {
    const chunker = new SentenceChunker();
    const beforeClose = chunker.push('```js\nconsole.log(1)\n');
    expect(beforeClose).toEqual([]);

    const afterClose = chunker.push('```\n\nDone.\n\n');
    expect(afterClose).toEqual(['Code block omitted.', 'Done.']);

    expect(chunker.flush()).toEqual([]);
  });

  it('holds an open fenced code block until flush() if it never closes', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('```js\nconsole.log(1)\n')).toEqual([]);
    expect(chunker.flush()).toEqual(['Code block omitted.']);
  });

  it('flush() still closes a fence whose opening line has no trailing newline', () => {
    // Regression: the opener line ("```js") is still sitting unterminated in
    // lineBuffer when flush() runs, so flush() must complete that line
    // (which opens the fence) *before* checking fenceOpen, or the fence
    // never gets closed/emitted.
    const chunker = new SentenceChunker();
    expect(chunker.push('Intro:\n```js')).toEqual(['Intro:']);
    expect(chunker.flush()).toEqual(['Code block omitted.']);
  });

  it('closes an in-progress table as soon as a plain line follows it, before that line emits', () => {
    // Regression: disqualifying a line into plain mode must resolve any
    // table in progress first, so the table summary comes out in order
    // (before the plain sentence that ended it), not deferred to flush().
    const chunker = new SentenceChunker();
    const emitted = chunker.push('| a | b |\n| - | - |\n| 1 | 2 |\nAfter.\n\n');
    expect(emitted).toEqual(['Table with 1 row omitted.', 'After.']);
    expect(chunker.flush()).toEqual([]);
  });

  it('emits a plain sentence that precedes a fence in the same paragraph as soon as it terminates', () => {
    const chunker = new SentenceChunker();
    // "Here is code:" ends in a colon followed by the newline before the
    // fence opener — that's a plain-text sentence boundary, independent of
    // the fence that follows, so it emits right away rather than waiting.
    const emitted = chunker.push('Here is code:\n```js\nconsole.log(1)\n```\n\n');
    expect(emitted).toEqual(['Here is code:', 'Code block omitted.']);
  });

  it('splits at the last whitespace before maxChars, never breaking a word', () => {
    const chunker = new SentenceChunker({ maxChars: 20 });
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel';
    const emitted = [...chunker.push(words), ...chunker.flush()];

    expect(emitted.join(' ')).toBe(words);
    for (const sentence of emitted) {
      expect(sentence.length).toBeLessThanOrEqual(20);
      expect(sentence.startsWith(' ')).toBe(false);
      expect(sentence.endsWith(' ')).toBe(false);
    }
  });

  // (d) Existing "streamed equals whole-push" and fixture tests still pass unchanged — only the
  // internal timing of emission changes, not the final sequence.
  it('produces the same sentences whether pushed as one string or one character at a time', () => {
    const text =
      'Hello there. This is a longer reply with a [link](https://example.com) in it.\n\n' +
      '## Next steps\n\n- Buy milk\n- Buy eggs.\n\nThanks!\n\n';

    const whole = new SentenceChunker();
    const wholeEmitted = [...whole.push(text), ...whole.flush()];

    const streamed = new SentenceChunker();
    const streamedEmitted = pushChars(streamed, text);

    expect(streamedEmitted).toEqual(wholeEmitted);
  });

  it('uses a default maxChars of 280', () => {
    const chunker = new SentenceChunker();
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const emitted = [...chunker.push(words), ...chunker.flush()];

    expect(emitted.length).toBeGreaterThan(1);
    for (const sentence of emitted) expect(sentence.length).toBeLessThanOrEqual(280);
  });
});
