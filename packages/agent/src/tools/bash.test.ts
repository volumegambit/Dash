import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashTool } from './bash.js';

describe('BashTool', () => {
  const tool = new BashTool();

  it('has correct definition', () => {
    expect(tool.name).toBe('bash');
    expect(tool.definition.name).toBe('bash');
    expect(tool.definition.input_schema.required).toContain('command');
  });

  it('executes echo command', async () => {
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.content).toBe('hello');
    expect(result.isError).toBeUndefined();
  });

  it('returns error for missing command', async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('command is required');
  });

  it('returns error for failing command', async () => {
    const result = await tool.execute({ command: 'exit 1' });
    expect(result.isError).toBe(true);
  });

  it('captures stderr on failure', async () => {
    const result = await tool.execute({ command: 'ls /nonexistent_path_xyz' });
    expect(result.isError).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe('BashTool with workspace', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'dash-bash-ws-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('runs commands in the workspace directory', async () => {
    const tool = new BashTool(dir);
    const result = await tool.execute({ command: 'pwd' });
    expect(result.content).toBe(dir);
    expect(result.isError).toBeUndefined();
  });

  it('includes workspace in tool description', () => {
    const tool = new BashTool(dir);
    expect(tool.definition.description).toContain(dir);
  });

  it('creates files within workspace', async () => {
    const tool = new BashTool(dir);
    await tool.execute({ command: 'echo "test" > sandbox.txt' });
    const result = await tool.execute({ command: 'cat sandbox.txt' });
    expect(result.content).toBe('test');
  });
});
