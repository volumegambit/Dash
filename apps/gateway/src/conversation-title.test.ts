import { describe, expect, it, vi } from 'vitest';
import type { CompleteFn } from './conversation-title.js';
import { generateConversationTitle, sanitizeTitle } from './conversation-title.js';

function makeCompleteFn(reply: string): CompleteFn {
  return vi.fn().mockResolvedValue({
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
    stopReason: 'stop',
  });
}

describe('sanitizeTitle', () => {
  it('strips wrapping quotes and trailing punctuation', () => {
    expect(sanitizeTitle('"Fixing the login bug."')).toBe('Fixing the login bug');
    expect(sanitizeTitle('“Deploy pipeline questions!”')).toBe('Deploy pipeline questions');
  });

  it('keeps only the first line', () => {
    expect(sanitizeTitle('Trip planning\nHere is a title for the chat')).toBe('Trip planning');
  });

  it('caps at 60 chars on a word boundary', () => {
    const long = 'word '.repeat(30).trim();
    const title = sanitizeTitle(long);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('word')).toBe(true);
  });

  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeTitle('  "" ')).toBe('');
    expect(sanitizeTitle('\n')).toBe('');
  });
});

describe('generateConversationTitle', () => {
  const base = {
    // pi-ai's baked registry knows anthropic models, so resolution works
    // without a plugin catalog in tests.
    modelStr: 'anthropic/claude-3-5-haiku-20241022',
    pluginModelCatalog: undefined,
    providerApiKeys: { anthropic: 'sk-test' },
  };

  it('returns the sanitized model reply', async () => {
    const completeFn = makeCompleteFn('"Login bug investigation."');
    const title = await generateConversationTitle({
      ...base,
      text: 'my login form crashes when I submit',
      completeFn,
    });
    expect(title).toBe('Login bug investigation');
  });

  it('passes the user text and the provider api key to the completion', async () => {
    const completeFn = makeCompleteFn('A title');
    await generateConversationTitle({ ...base, text: 'hello world', completeFn });
    const [model, context, options] = (completeFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(model.provider).toBe('anthropic');
    expect(context.messages[0].content).toBe('hello world');
    expect(context.systemPrompt).toMatch(/title/i);
    expect(options.apiKey).toBe('sk-test');
  });

  it('truncates very long first messages before sending', async () => {
    const completeFn = makeCompleteFn('A title');
    await generateConversationTitle({ ...base, text: 'x'.repeat(5000), completeFn });
    const [, context] = (completeFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(context.messages[0].content.length).toBeLessThanOrEqual(2000);
  });

  it('throws when no api key is stored for the provider', async () => {
    await expect(
      generateConversationTitle({
        ...base,
        providerApiKeys: {},
        text: 'hello',
        completeFn: makeCompleteFn('A title'),
      }),
    ).rejects.toThrow(/No API key/);
  });

  it('throws when the model returns no usable text', async () => {
    await expect(
      generateConversationTitle({ ...base, text: 'hello', completeFn: makeCompleteFn('""') }),
    ).rejects.toThrow(/no usable text/);
  });

  it('enforces the agent provider allow-list', async () => {
    await expect(
      generateConversationTitle({
        ...base,
        allowedProviders: ['openai'],
        text: 'hello',
        completeFn: makeCompleteFn('A title'),
      }),
    ).rejects.toThrow(/not allowed/);
  });
});
