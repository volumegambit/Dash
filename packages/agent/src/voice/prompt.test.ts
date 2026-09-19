import { composeVoicePrompt } from './prompt.js';

describe('composeVoicePrompt', () => {
  it('wraps the block in a <voice> tag', () => {
    const out = composeVoicePrompt();
    expect(out.startsWith('<voice>')).toBe(true);
    expect(out.endsWith('</voice>')).toBe(true);
  });

  it('states the spoken-mode framing', () => {
    expect(composeVoicePrompt()).toContain(
      'The user is speaking to you and will hear your reply read aloud by a text-to-speech voice.',
    );
  });

  it('carries every spoken-mode rule', () => {
    const out = composeVoicePrompt();
    expect(out).toContain('- Answer in short spoken sentences. Lead with the answer.');
    expect(out).toContain(
      '- No markdown, code blocks, tables, bullet lists or headings; say a file name or command in words instead of printing it.',
    );
    expect(out).toContain(
      '- When you use a tool, say what you are doing in one clause, then continue.',
    );
    expect(out).toContain(
      '- If you need to show something long (code, a table, a list), keep it to what can be spoken and tell the user it is in the transcript.',
    );
    expect(out).toContain('- Ask one question at a time.');
  });

  it('is a pure constant — two calls produce identical output', () => {
    expect(composeVoicePrompt()).toBe(composeVoicePrompt());
  });
});
