import { describe, expect, it } from 'vitest';
import { insertNewlineAtSelection } from './composer.js';

describe('insertNewlineAtSelection', () => {
  it('appends when the caret is at the end', () => {
    expect(insertNewlineAtSelection('ab', 2, 2)).toEqual({ value: 'ab\n', caret: 3 });
  });

  it('splits at the caret rather than appending', () => {
    // The whole reason this is not a `value + "\n"` one-liner: someone who
    // clicked back into the middle of a half-written message expects the
    // break where their caret is.
    expect(insertNewlineAtSelection('ab', 1, 1)).toEqual({ value: 'a\nb', caret: 2 });
  });

  it('replaces a selection', () => {
    expect(insertNewlineAtSelection('abcd', 1, 3)).toEqual({ value: 'a\nd', caret: 2 });
  });

  it('handles an empty draft', () => {
    expect(insertNewlineAtSelection('', 0, 0)).toEqual({ value: '\n', caret: 1 });
  });

  it('clamps indices past the end of the value', () => {
    expect(insertNewlineAtSelection('ab', 5, 9)).toEqual({ value: 'ab\n', caret: 3 });
  });

  it('clamps negative indices', () => {
    expect(insertNewlineAtSelection('ab', -3, -1)).toEqual({ value: '\nab', caret: 1 });
  });

  it('tolerates a backwards selection', () => {
    // A selection dragged right-to-left reports anchor > focus in some
    // browsers; the newline still belongs at the lower index.
    expect(insertNewlineAtSelection('abcd', 3, 1)).toEqual({ value: 'a\nd', caret: 2 });
  });

  it('falls back to the end when the browser reports a null selection', () => {
    // `selectionStart` is null for input types that do not support it; the
    // DOM types surface that as a number, so it arrives here as NaN.
    expect(insertNewlineAtSelection('ab', Number.NaN, Number.NaN)).toEqual({
      value: 'ab\n',
      caret: 3,
    });
  });
});
