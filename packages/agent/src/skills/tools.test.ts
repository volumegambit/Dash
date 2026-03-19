import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCreateSkillTool, createLoadSkillTool } from './tools.js';
import type { SkillDiscoveryResult } from './types.js';

describe('createLoadSkillTool', () => {
  const mockSkills: SkillDiscoveryResult[] = [
    {
      name: 'deploy-staging',
      description: 'Deploy to staging',
      location: '/skills/deploy-staging/SKILL.md',
      content: 'Step 1: Run deploy script\nStep 2: Verify',
      editable: true,
      source: 'managed',
    },
    {
      name: 'run-tests',
      description: 'Run test suite',
      location: '/skills/run-tests/SKILL.md',
      content: 'Execute: npm test',
      editable: true,
      source: 'agent',
    },
  ];

  const listSkillsFn = async () => mockSkills;
  const tool = createLoadSkillTool(listSkillsFn);

  it('returns skill content when found', async () => {
    const result = await tool.execute('call-1', { name: 'deploy-staging' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Step 1: Run deploy script\nStep 2: Verify',
    });
  });

  it('returns error when skill not found', async () => {
    const result = await tool.execute('call-2', { name: 'nonexistent' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('not found');
    expect(text).toContain('deploy-staging');
    expect(text).toContain('run-tests');
  });
});

describe('createCreateSkillTool', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'skill-tools-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates skill with required fields only', async () => {
    const tool = createCreateSkillTool(tmpDir);
    const result = await tool.execute('call-1', {
      name: 'my-skill',
      description: 'A test skill',
      content: 'Do the thing.',
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('created');
    expect(text).toContain('my-skill');

    const skillFile = join(tmpDir, 'my-skill', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);

    const raw = await readFile(skillFile, 'utf-8');
    expect(raw).toContain('name: my-skill');
    expect(raw).toContain('description: A test skill');
    expect(raw).toContain('Do the thing.');
  });

  it('creates skill with all optional fields', async () => {
    const tool = createCreateSkillTool(tmpDir);
    const result = await tool.execute('call-1', {
      name: 'full-skill',
      description: 'Full featured skill',
      content: 'Complete instructions here.',
      trigger: 'deploy',
      tools: ['bash', 'read'],
      tags: ['deployment', 'ci'],
      model: 'anthropic/claude-sonnet-4-20250514',
      context: 'fork' as const,
      allowed_tools: ['bash'],
      dependencies: ['setup-env'],
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('created');

    const raw = await readFile(join(tmpDir, 'full-skill', 'SKILL.md'), 'utf-8');
    expect(raw).toContain('trigger: deploy');
    expect(raw).toContain('tools:');
    expect(raw).toContain('  - bash');
    expect(raw).toContain('  - read');
    expect(raw).toContain('tags:');
    expect(raw).toContain('  - deployment');
    expect(raw).toContain('model: anthropic/claude-sonnet-4-20250514');
    expect(raw).toContain('context: fork');
    expect(raw).toContain('allowed-tools:');
    expect(raw).toContain('dependencies:');
    expect(raw).toContain('  - setup-env');
    expect(raw).toContain('Complete instructions here.');
  });

  it('rejects invalid name with uppercase', async () => {
    const tool = createCreateSkillTool(tmpDir);
    const result = await tool.execute('call-1', {
      name: 'MySkill',
      description: 'Bad name',
      content: 'content',
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Invalid skill name');
  });

  it('rejects invalid name with special chars', async () => {
    const tool = createCreateSkillTool(tmpDir);
    const result = await tool.execute('call-1', {
      name: 'my_skill!',
      description: 'Bad name',
      content: 'content',
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Invalid skill name');
  });

  it('rejects duplicate skill name', async () => {
    const tool = createCreateSkillTool(tmpDir);

    // Create the first one
    await tool.execute('call-1', {
      name: 'dup-skill',
      description: 'First',
      content: 'content',
    });

    // Try to create a duplicate
    const result = await tool.execute('call-2', {
      name: 'dup-skill',
      description: 'Second',
      content: 'other content',
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('already exists');
  });

  it('rejects empty content', async () => {
    const tool = createCreateSkillTool(tmpDir);
    const result = await tool.execute('call-1', {
      name: 'empty-skill',
      description: 'Empty',
      content: '   ',
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('cannot be empty');
  });

  it('creates .source marker file with value agent', async () => {
    const tool = createCreateSkillTool(tmpDir);
    await tool.execute('call-1', {
      name: 'sourced-skill',
      description: 'Test source marker',
      content: 'instructions',
    });

    const sourceFile = join(tmpDir, 'sourced-skill', '.source');
    expect(existsSync(sourceFile)).toBe(true);

    const sourceContent = await readFile(sourceFile, 'utf-8');
    expect(sourceContent).toBe('agent');
  });
});
