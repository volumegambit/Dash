import { describe, expect, it } from 'vitest';
import { looksLikeCorrection } from './correction.js';

describe('looksLikeCorrection', () => {
  it.each([
    'Stop using echo to write files.',
    "Don't do it that way.",
    'Do not use the staging bucket for this.',
    'Never commit directly to main.',
    'You must always run the generator first.',
    'Use printf instead of echo.',
    'Write it with a script rather than by hand.',
    'That is wrong — the endpoint takes a POST.',
    "That's not what I asked for.",
    'Why did you delete the fixtures?',
    'I told you to check the logs first.',
    'Remember that this project pins Node 22.',
    'From now on, put migrations in db/migrations.',
  ])('recognises a correction: %s', (text) => {
    expect(looksLikeCorrection(text)).toBe(true);
  });

  it.each([
    'Create a directory called notes and add two files.',
    'What does this function do?',
    'Thanks, that looks right.',
    'Please summarise the report.',
    'Run the tests and show me the output.',
    '',
    '   ',
  ])('does not fire on ordinary instruction: %s', (text) => {
    expect(looksLikeCorrection(text)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(looksLikeCorrection('STOP USING ECHO')).toBe(true);
  });
});
