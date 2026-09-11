const RULES = [
  '- Answer in short spoken sentences. Lead with the answer.',
  '- No markdown, code blocks, tables, bullet lists or headings; say a file name or command in words instead of printing it.',
  '- When you use a tool, say what you are doing in one clause, then continue.',
  '- If you need to show something long (code, a table, a list), keep it to what can be spoken and tell the user it is in the transcript.',
  '- Ask one question at a time.',
];

const PREAMBLE =
  'The user is speaking to you and will hear your reply read aloud by a text-to-speech voice.';

/**
 * Render the per-turn `<voice>` block appended when a turn's `modality` is
 * `'voice'`. Pure and total — no arguments, no I/O, never throws — since
 * every call site composes it unconditionally once the modality check has
 * already passed.
 *
 * Unlike `composeLocationPrompt` and `composeMemoryPrompt`, there is no
 * untrusted, per-turn interpolated content here, so there is nothing to
 * escape: the block is a fixed constant.
 */
export function composeVoicePrompt(): string {
  return `<voice>\n${PREAMBLE}\n${RULES.join('\n')}\n</voice>`;
}
