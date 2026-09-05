import { parseAgentDefinition, splitToolList } from './definition.js';

const meta = { source: 'agent' as const, location: '/x/reviewer.md' };

describe('parseAgentDefinition', () => {
  it('parses every honored key and the body', () => {
    const raw =
      '---\nname: code-reviewer\ndescription: Reviews diffs\ntools: read, grep, agent(Explore, Plan)\ndisallowedTools: write\nmodel: inherit\nskills:\n  - conventions\nmaxTurns: 40\nbackground: true\nisolation: worktree\npermissionMode: auto\n---\nYou review.';
    const r = parseAgentDefinition(raw, meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition).toMatchObject({
      name: 'code-reviewer',
      description: 'Reviews diffs',
      tools: ['read', 'grep', 'agent(Explore, Plan)'],
      disallowedTools: ['write'],
      model: 'inherit',
      skills: ['conventions'],
      maxTurns: 40,
      background: true,
      isolation: 'worktree',
      ignoredKeys: ['permissionMode'],
      systemPrompt: 'You review.',
    });
  });
  it('requires name and description and validates name shape', () => {
    expect(parseAgentDefinition('---\ndescription: d\n---\nb', meta)).toEqual({
      ok: false,
      error: 'name is required',
    });
    expect(parseAgentDefinition('---\nname: Bad_Name\ndescription: d\n---\nb', meta)).toEqual({
      ok: false,
      error: 'name must match ^[a-z0-9][a-z0-9-]*$',
    });
    expect(parseAgentDefinition('---\nname: ok\n---\nb', meta)).toEqual({
      ok: false,
      error: 'description is required',
    });
  });
  it('rejects bad maxTurns and isolation values', () => {
    expect(
      parseAgentDefinition('---\nname: a\ndescription: d\nmaxTurns: -1\n---\nb', meta),
    ).toEqual({
      ok: false,
      error: 'maxTurns must be a positive integer',
    });
    expect(
      parseAgentDefinition('---\nname: a\ndescription: d\nisolation: container\n---\nb', meta),
    ).toEqual({
      ok: false,
      error: 'isolation must be "worktree"',
    });
  });
  it('namespaces plugin definitions', () => {
    const r = parseAgentDefinition('---\nname: a\ndescription: d\n---\nb', {
      source: 'plugin',
      location: '/p/agents/a.md',
      namespace: 'p',
    });
    expect(r.ok && r.definition.name).toBe('p:a');
  });
  it('splitToolList handles commas inside agent()', () => {
    expect(splitToolList('read, agent(a, b), mcp__*')).toEqual(['read', 'agent(a, b)', 'mcp__*']);
    expect(splitToolList(['read'])).toEqual(['read']);
    expect(splitToolList(undefined)).toBeUndefined();
  });
});
