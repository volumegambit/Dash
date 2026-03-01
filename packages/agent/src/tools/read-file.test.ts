import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadFileTool } from './read-file.js';

describe('ReadFileTool', () => {
  const tool = new ReadFileTool();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-rf-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('has correct definition', () => {
    expect(tool.name).toBe('read_file');
    expect(tool.definition.name).toBe('read_file');
    expect(tool.definition.input_schema.required).toContain('path');
  });

  it('reads a file', async () => {
    const file = join(dir, 'test.txt');
    await writeFile(file, 'hello world');
    const result = await tool.execute({ path: file });
    expect(result.content).toBe('hello world');
    expect(result.isError).toBeUndefined();
  });

  it('returns error for missing path', async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('path is required');
  });

  it('returns error for nonexistent file', async () => {
    const result = await tool.execute({ path: '/nonexistent_file_xyz.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error reading file');
  });

  it('reads empty file', async () => {
    const file = join(dir, 'empty.txt');
    await writeFile(file, '');
    const result = await tool.execute({ path: file });
    expect(result.content).toBe('(empty file)');
  });
});

describe('ReadFileTool with workspace', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'dash-rf-ws-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true });
  });

  it('reads file with relative path', async () => {
    await writeFile(join(workspace, 'hello.txt'), 'sandboxed');
    const tool = new ReadFileTool(workspace);
    const result = await tool.execute({ path: 'hello.txt' });
    expect(result.content).toBe('sandboxed');
    expect(result.isError).toBeUndefined();
  });

  it('reads file in subdirectory', async () => {
    await mkdir(join(workspace, 'sub'));
    await writeFile(join(workspace, 'sub/deep.txt'), 'nested');
    const tool = new ReadFileTool(workspace);
    const result = await tool.execute({ path: 'sub/deep.txt' });
    expect(result.content).toBe('nested');
  });

  it('rejects ../ escape attempts', async () => {
    const tool = new ReadFileTool(workspace);
    const result = await tool.execute({ path: '../../../etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes the workspace');
  });

  it('rejects absolute path outside workspace', async () => {
    const tool = new ReadFileTool(workspace);
    const result = await tool.execute({ path: '/etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes the workspace');
  });

  it('allows absolute path inside workspace', async () => {
    const file = join(workspace, 'abs.txt');
    await writeFile(file, 'absolute ok');
    const tool = new ReadFileTool(workspace);
    const result = await tool.execute({ path: file });
    expect(result.content).toBe('absolute ok');
  });

  it('includes workspace in tool description', () => {
    const tool = new ReadFileTool(workspace);
    expect(tool.definition.description).toContain(workspace);
  });
});
