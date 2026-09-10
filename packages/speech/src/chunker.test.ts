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

  it('holds an open fenced code block until it closes, then emits', () => {
    const chunker = new SentenceChunker();
    // No blank line before the fence: "Here is code:" and the fence are the
    // same paragraph, so nothing may emit until the fence closes.
    const beforeClose = chunker.push('Here is code:\n```js\nconsole.log(1)\n');
    expect(beforeClose).toEqual([]);

    // The closing fence, a blank line, and "Done." all arrive in this one push.
    // "Here is code:" and "Done." each end their own sentence (colon and
    // blank-line triggers), so all three sentences land in one call.
    const afterClose = chunker.push('```\n\nDone.\n\n');
    expect(afterClose).toEqual(['Here is code:', 'Code block omitted.', 'Done.']);

    expect(chunker.flush()).toEqual([]);
  });

  it('holds an open fenced code block until flush() if it never closes', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Here is code:\n```js\nconsole.log(1)\n')).toEqual([]);
    expect(chunker.flush()).toEqual(['Here is code:', 'Code block omitted.']);
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
