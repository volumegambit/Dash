/**
 * Recognising a correction in what the user just said.
 *
 * The effort gate exists so a purely conversational turn never costs a model
 * call. On its own, though, it discards the single most valuable thing the
 * review could learn from: a turn where the user says "stop doing that, always
 * do this instead" typically runs one tool call or none at all, so counting
 * tool calls filters out exactly the signal the feature is built to capture.
 *
 * This is the cheap escape hatch — a text match on the user's own message, no
 * model involved. A false positive costs one extra review call; a false
 * negative costs a lesson that never gets learned, which is the more expensive
 * mistake. The patterns are therefore deliberately generous.
 *
 * Only the USER's text is ever scanned. The assistant's own wording is full of
 * phrases like "I'll never..." and would match constantly.
 */

const CORRECTION_PATTERNS: RegExp[] = [
  // Direct prohibitions and standing rules.
  /\b(?:do\s?n[o']?t|don't|never|always|must\s+(?:not\s+)?)\b/i,
  /\bstop\s+(?:doing|using|adding|writing|saying|that)\b/i,
  /\bno\s+longer\b/i,
  // Redirection to a different approach.
  /\binstead\s+of\b/i,
  /\buse\s+\S+\s+instead\b/i,
  /\brather\s+than\b/i,
  // Explicit dissatisfaction with what just happened.
  /\bthat(?:'s| is| was)\s+(?:wrong|incorrect|not right|not what)\b/i,
  /\bnot\s+what\s+I\s+(?:asked|meant|wanted)\b/i,
  /\bwhy\s+did\s+you\b/i,
  /\bI\s+(?:told|asked)\s+you\b/i,
  // An explicit instruction to retain something.
  /\b(?:remember|from\s+now\s+on|going\s+forward)\b/i,
];

/**
 * Whether the user's message reads as a correction or a standing instruction.
 *
 * Used to admit a turn for review that the tool-call gate would otherwise skip.
 */
export function looksLikeCorrection(userText: string): boolean {
  const text = userText.trim();
  if (text.length === 0) return false;
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}
