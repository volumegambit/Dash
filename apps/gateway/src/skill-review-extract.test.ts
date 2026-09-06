import { describe, expect, it, vi } from 'vitest';
import { extractLessonDeltas, parseReviewReply } from './skill-review-extract.js';

describe('parseReviewReply', () => {
  it('parses a well-formed reply', () => {
    const deltas = parseReviewReply(
      '{"deltas":[{"op":"add","skill":"a-skill","text":"Do the thing first.","description":"d"}]}',
    );

    expect(deltas).toEqual([
      { op: 'add', skill: 'a-skill', text: 'Do the thing first.', description: 'd', augments: [] },
    ]);
  });

  it('parses all three operations', () => {
    const deltas = parseReviewReply(
      '{"deltas":[' +
        '{"op":"add","skill":"s","text":"t"},' +
        '{"op":"helpful","skill":"s","id":"abc123"},' +
        '{"op":"harmful","skill":"s","id":"def456","reason":"wrong"}]}',
    );

    expect(deltas.map((d) => d.op)).toEqual(['add', 'helpful', 'harmful']);
  });

  it('tolerates prose wrapped around the JSON', () => {
    const deltas = parseReviewReply(
      'Here is what I found:\n{"deltas":[{"op":"add","skill":"s","text":"t"}]}\nHope that helps.',
    );

    expect(deltas).toHaveLength(1);
  });

  it('tolerates a fenced code block', () => {
    const deltas = parseReviewReply(
      '```json\n{"deltas":[{"op":"add","skill":"s","text":"t"}]}\n```',
    );

    expect(deltas).toHaveLength(1);
  });

  it('returns an empty list for the explicit empty answer', () => {
    expect(parseReviewReply('{"deltas":[]}')).toEqual([]);
  });

  it.each([
    ['malformed JSON', '{"deltas": [ '],
    ['no JSON at all', 'I did not find anything worth recording.'],
    ['an empty string', ''],
    ['a JSON array rather than an object', '[{"op":"add"}]'],
    ['deltas of the wrong type', '{"deltas":"lots"}'],
  ])('returns an empty list for %s', (_label, raw) => {
    expect(parseReviewReply(raw)).toEqual([]);
  });

  it('drops individual invalid deltas but keeps the valid ones', () => {
    const deltas = parseReviewReply(
      '{"deltas":[' +
        '{"op":"add","skill":"s","text":"kept"},' +
        '{"op":"nonsense","skill":"s"},' +
        '{"op":"add","skill":"s"},' +
        '{"op":"helpful","skill":"s"},' +
        '{"op":"add","text":"no skill"},' +
        '{"op":"add","skill":"s","text":"   "},' +
        '{"op":"harmful","skill":"s","id":"abc123"}]}',
    );

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ op: 'add', text: 'kept' });
    expect(deltas[1]).toMatchObject({ op: 'harmful', id: 'abc123' });
  });

  it('flattens lesson text so a stored lesson cannot restructure a later prompt', () => {
    const deltas = parseReviewReply(
      JSON.stringify({ deltas: [{ op: 'add', skill: 's', text: 'one\n\n## two' }] }),
    );

    expect(deltas[0]).toMatchObject({ op: 'add', text: 'one ## two' });
  });

  it('ignores augments that are not an array of strings', () => {
    const deltas = parseReviewReply(
      JSON.stringify({ deltas: [{ op: 'add', skill: 's', text: 't', augments: 'dash-dev' }] }),
    );

    expect(deltas[0]).toMatchObject({ augments: [] });
  });
});

describe('extractLessonDeltas', () => {
  const model = 'anthropic/claude-3-5-haiku-20241022';

  function completeReturning(text: string) {
    return vi.fn().mockResolvedValue({ content: [{ type: 'text', text }] });
  }

  it('sends the review prompt and parses the reply', async () => {
    const completeFn = completeReturning('{"deltas":[{"op":"add","skill":"s","text":"t"}]}');

    const deltas = await extractLessonDeltas({
      modelStr: model,
      pluginModelCatalog: undefined,
      providerApiKeys: { anthropic: 'key' },
      userText: 'user said',
      assistantText: 'assistant said',
      books: [],
      loadedSkills: [],
      completeFn,
    });

    expect(deltas).toHaveLength(1);
    const [, request] = completeFn.mock.calls[0];
    expect(request.systemPrompt).toMatch(/no lessons/i);
    expect(request.messages[0].content).toContain('user said');
    expect(request.messages[0].content).toContain('assistant said');
  });

  it('throws when the provider has no stored key', async () => {
    await expect(
      extractLessonDeltas({
        modelStr: model,
        pluginModelCatalog: undefined,
        providerApiKeys: {},
        userText: 'u',
        assistantText: 'a',
        books: [],
        loadedSkills: [],
        completeFn: completeReturning('{"deltas":[]}'),
      }),
    ).rejects.toThrow(/no api key/i);
  });

  it('truncates a very long exchange before sending it', async () => {
    const completeFn = completeReturning('{"deltas":[]}');

    await extractLessonDeltas({
      modelStr: model,
      pluginModelCatalog: undefined,
      providerApiKeys: { anthropic: 'key' },
      userText: 'u'.repeat(50_000),
      assistantText: 'a'.repeat(50_000),
      books: [],
      loadedSkills: [],
      completeFn,
    });

    const [, request] = completeFn.mock.calls[0];
    expect(request.messages[0].content.length).toBeLessThan(20_000);
  });
});
