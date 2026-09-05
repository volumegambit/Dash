import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_RULES, buildMemoryPrompt, composeMemoryPrompt } from './prompt.js';
import { MemoryStore } from './store.js';

describe('buildMemoryPrompt', () => {
  it('wraps the rules and the index in a <memory> block', () => {
    const out = buildMemoryPrompt({ index: '# Memory index\n\n_No memories yet._\n' });
    expect(out.startsWith('<memory>\n')).toBe(true);
    expect(out).toContain(MEMORY_RULES);
    expect(out).toContain('# Memory index');
    expect(out.trimEnd().endsWith('</memory>')).toBe(true);
    expect(out).not.toContain('<recalled-memories>');
  });

  it('appends a <recalled-memories> block with bodies when recalled records are given', () => {
    const out = buildMemoryPrompt({
      index: '# Memory index\n',
      recalled: [
        {
          name: 'user-timezone',
          description: 'Gerry is in Singapore',
          type: 'user',
          source: 'agent',
          createdAt: '2026-09-05',
          updatedAt: '2026-09-05',
          content: 'Gerry lives in Singapore (UTC+8).',
        },
      ],
    });
    expect(out).toContain('<recalled-memories>');
    expect(out).toContain('### user-timezone (user)');
    expect(out).toContain('Gerry lives in Singapore (UTC+8).');
    expect(out).toContain('background context');
  });

  it('escapes closing delimiter in memory bodies so they cannot prematurely terminate the block', () => {
    const out = buildMemoryPrompt({
      index: '# Memory index\n',
      recalled: [
        {
          name: 'test-memory',
          description: 'Test memory with closing delimiter',
          type: 'project',
          source: 'user',
          createdAt: '2026-09-05',
          updatedAt: '2026-09-05',
          content: 'This contains </recalled-memories> in the body',
        },
      ],
    });
    expect(out).toContain('<recalled-memories>');
    expect(out.trimEnd().endsWith('</recalled-memories>')).toBe(true);
    const closingDelimiterCount = (out.match(/\<\/recalled-memories\>/g) || []).length;
    expect(closingDelimiterCount).toBe(1);
    expect(out).toContain('</ recalled-memories>');
  });
});

describe('composeMemoryPrompt', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-memory-prompt-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders the index from the store directory', async () => {
    const store = new MemoryStore(dir);
    await store.save({
      name: 'a',
      description: 'alpha fact',
      type: 'project',
      content: 'x',
      source: 'agent',
    });
    const out = await composeMemoryPrompt(dir, 'hello');
    expect(out).toContain('- **a** — alpha fact');
  });

  it('renders an empty index for a missing directory', async () => {
    const out = await composeMemoryPrompt(join(dir, 'nope'), 'hello');
    expect(out).toContain('_No memories yet._');
  });

  it('recalls memories whose description overlaps the message and includes their bodies', async () => {
    const store = new MemoryStore(dir);
    await store.save({
      name: 'deploy-staging',
      description: 'deploy to staging with wrangler',
      type: 'project',
      content: 'Run npm run deploy:staging',
      source: 'agent',
    });
    await store.save({
      name: 'tz',
      description: 'Gerry is in Singapore',
      type: 'user',
      content: 'UTC+8',
      source: 'agent',
    });
    const out = await composeMemoryPrompt(dir, 'how do I deploy to staging?');
    expect(out).toContain('<recalled-memories>');
    expect(out).toContain('Run npm run deploy:staging');
    expect(out).not.toContain('UTC+8');
  });
});
