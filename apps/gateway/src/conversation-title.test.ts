import { describe, expect, it, vi } from 'vitest';
import type { CompleteFn } from './conversation-title.js';
import { generateConversationTitle, parseTitleReply, sanitizeTitle } from './conversation-title.js';

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
    const result = await generateConversationTitle({
      ...base,
      text: 'my login form crashes when I submit',
      completeFn,
    });
    expect(result).toEqual({ title: 'Login bug investigation', projectKey: null });
  });

  it('classifies into a project when candidates are provided', async () => {
    const completeFn = makeCompleteFn('{"title":"Fix login crash","project":"AUTH"}');
    const result = await generateConversationTitle({
      ...base,
      text: 'my login form crashes when I submit',
      projects: [
        { key: 'AUTH', name: 'Auth revamp' },
        { key: 'PETS', name: 'Companion pets' },
      ],
      completeFn,
    });
    expect(result).toEqual({ title: 'Fix login crash', projectKey: 'AUTH' });
    const [, context] = (completeFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(context.systemPrompt).toContain('AUTH: Auth revamp');
    expect(context.systemPrompt).toContain('PETS: Companion pets');
  });

  it('drops an inferred project the candidate list does not contain', async () => {
    const completeFn = makeCompleteFn('{"title":"Fix login crash","project":"NOPE"}');
    const result = await generateConversationTitle({
      ...base,
      text: 'my login form crashes',
      projects: [{ key: 'AUTH', name: 'Auth revamp' }],
      completeFn,
    });
    expect(result).toEqual({ title: 'Fix login crash', projectKey: null });
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

describe('parseTitleReply', () => {
  const projects = [{ key: 'AUTH', name: 'Auth revamp' }];

  it('parses JSON with a matching project key case-insensitively', () => {
    expect(parseTitleReply('{"title":"Fix login","project":"auth"}', projects)).toEqual({
      title: 'Fix login',
      projectKey: 'AUTH',
    });
  });

  it('tolerates code fences and surrounding prose', () => {
    expect(
      parseTitleReply('Sure! ```json\n{"title":"Fix login","project":null}\n```', projects),
    ).toEqual({ title: 'Fix login', projectKey: null });
  });

  it('falls back to plain-title parsing for non-JSON replies', () => {
    expect(parseTitleReply('"Fix login."', projects)).toEqual({
      title: 'Fix login',
      projectKey: null,
    });
  });
});
