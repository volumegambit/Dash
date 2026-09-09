/**
 * Splices a newline into `value` at the caret/selection, returning the new
 * value and where the caret should land.
 *
 * Extracted as a pure function (rather than mutating the textarea inline)
 * because the interesting behaviour is entirely index arithmetic — replacing
 * a selection, clamping indices a browser could report out of range — and
 * that is worth testing without a DOM.
 *
 * Deliberately duplicated in Mission Control's `chat.helpers.ts`: web and
 * mission-control share no UI package, and a cross-package dependency for
 * eight lines of arithmetic would cost more than the duplication does.
 */
export function insertNewlineAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const max = value.length;
  const rawStart = Number.isFinite(selectionStart) ? selectionStart : max;
  const rawEnd = Number.isFinite(selectionEnd) ? selectionEnd : max;
  const a = Math.min(Math.max(rawStart, 0), max);
  const b = Math.min(Math.max(rawEnd, 0), max);
  const start = Math.min(a, b);
  const end = Math.max(a, b);

  return {
    value: `${value.slice(0, start)}\n${value.slice(end)}`,
    caret: start + 1,
  };
}
