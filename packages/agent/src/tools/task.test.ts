import { createTaskTool } from './task.js';

function getText(result: { content: { type: string; text: string }[] }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('createTaskTool', () => {
  it('creates a task and returns the task list', async () => {
    const tool = createTaskTool();
    const result = await tool.execute('call-1', {
      action: 'create',
      subject: 'Set up database',
    });

    const text = getText(result);
    expect(text).toContain('Task #1 created');
    expect(text).toContain('#1. [pending] Set up database');
    expect(text).toContain('Tasks (0/1 completed)');
  });

  it('lists all tasks', async () => {
    const tool = createTaskTool();
    await tool.execute('call-1', { action: 'create', subject: 'Set up database' });
    await tool.execute('call-2', { action: 'create', subject: 'Write API' });

    const result = await tool.execute('call-3', { action: 'list' });
    const text = getText(result);

    expect(text).toContain('Tasks (0/2 completed)');
    expect(text).toContain('#1. [pending] Set up database');
    expect(text).toContain('#2. [pending] Write API');
  });

  it('updates task status', async () => {
    const tool = createTaskTool();
    await tool.execute('call-1', { action: 'create', subject: 'Set up database' });
    await tool.execute('call-2', { action: 'create', subject: 'Write API' });

    const result = await tool.execute('call-3', {
      action: 'update',
      taskId: '1',
      status: 'completed',
    });

    const text = getText(result);
    expect(text).toContain('Task #1 updated');
    expect(text).toContain('#1. [completed] Set up database');
    expect(text).toContain('Tasks (1/2 completed)');
  });

  it('gets a specific task with description', async () => {
    const tool = createTaskTool();
    await tool.execute('call-1', {
      action: 'create',
      subject: 'Set up database',
      description: 'Initialize PostgreSQL with schema migrations',
    });

    const result = await tool.execute('call-2', { action: 'get', taskId: '1' });
    const text = getText(result);

    expect(text).toContain('#1. [pending] Set up database');
    expect(text).toContain('Description: Initialize PostgreSQL with schema migrations');
  });

  it('returns error for unknown task ID on get', async () => {
    const tool = createTaskTool();
    const result = await tool.execute('call-1', { action: 'get', taskId: '99' });
    const text = getText(result);

    expect(text).toContain('Error');
    expect(text).toContain('#99');
    expect(text).toContain('not found');
  });

  it('returns error for unknown task ID on update', async () => {
    const tool = createTaskTool();
    const result = await tool.execute('call-1', {
      action: 'update',
      taskId: '99',
      status: 'completed',
    });
    const text = getText(result);

    expect(text).toContain('Error');
    expect(text).toContain('#99');
    expect(text).toContain('not found');
  });

  it('returns error when subject missing for create', async () => {
    const tool = createTaskTool();
    const result = await tool.execute('call-1', { action: 'create' });
    const text = getText(result);

    expect(text).toContain('Error');
    expect(text).toContain('subject is required');
  });

  it('returns error when taskId missing for update', async () => {
    const tool = createTaskTool();
    const result = await tool.execute('call-1', { action: 'update', status: 'completed' });
    const text = getText(result);

    expect(text).toContain('Error');
    expect(text).toContain('taskId is required');
  });

  it('returns error when taskId missing for get', async () => {
    const tool = createTaskTool();
    const result = await tool.execute('call-1', { action: 'get' });
    const text = getText(result);

    expect(text).toContain('Error');
    expect(text).toContain('taskId is required');
  });

  it('shows empty task list when no tasks exist', async () => {
    const tool = createTaskTool();
    const result = await tool.execute('call-1', { action: 'list' });
    const text = getText(result);

    expect(text).toContain('Tasks (0/0 completed)');
    expect(text).toContain('(no tasks)');
  });

  it('each tool instance has independent state', async () => {
    const toolA = createTaskTool();
    const toolB = createTaskTool();

    await toolA.execute('call-1', { action: 'create', subject: 'Task A' });

    const resultB = await toolB.execute('call-2', { action: 'list' });
    expect(getText(resultB)).toContain('(no tasks)');
  });

  it('tracks completed vs total count correctly across multiple updates', async () => {
    const tool = createTaskTool();
    await tool.execute('call-1', { action: 'create', subject: 'Task one' });
    await tool.execute('call-2', { action: 'create', subject: 'Task two' });
    await tool.execute('call-3', { action: 'create', subject: 'Task three' });

    await tool.execute('call-4', { action: 'update', taskId: '1', status: 'completed' });
    await tool.execute('call-5', { action: 'update', taskId: '2', status: 'in_progress' });

    const result = await tool.execute('call-6', { action: 'list' });
    const text = getText(result);

    expect(text).toContain('Tasks (1/3 completed)');
    expect(text).toContain('#1. [completed] Task one');
    expect(text).toContain('#2. [in_progress] Task two');
    expect(text).toContain('#3. [pending] Task three');
  });
});
