import { createTodoWriteTool } from './todowrite.js';

describe('createTodoWriteTool', () => {
  const tool = createTodoWriteTool();

  it('has the correct name, label, and description', () => {
    expect(tool.name).toBe('task');
    expect(tool.label).toBe('Task');
    expect(tool.description).toContain('replaces the previous state');
  });

  it('accepts a todo list and returns a formatted summary', async () => {
    const result = await tool.execute('call-1', {
      todos: [
        { id: '1', content: 'Set up database', status: 'completed', priority: 'high' },
        { id: '2', content: 'Write API', status: 'in_progress', priority: 'medium' },
        { id: '3', content: 'Add tests', status: 'pending', priority: 'low' },
        { id: '4', content: 'Deploy', status: 'pending' },
        { id: '5', content: 'Review docs', status: 'completed' },
      ],
    });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('2/5 completed');
    expect(text).toContain('✓ Set up database [high]');
    expect(text).toContain('◉ Write API [medium]');
    expect(text).toContain('○ Add tests [low]');
    expect(text).toContain('○ Deploy');
    expect(text).toContain('✓ Review docs');
  });

  it('handles an empty todo list', async () => {
    const result = await tool.execute('call-2', { todos: [] });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('0/0 completed');
  });

  it('handles todos without priority', async () => {
    const result = await tool.execute('call-3', {
      todos: [
        { id: '1', content: 'Do something', status: 'pending' },
        { id: '2', content: 'Do another thing', status: 'completed' },
      ],
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('1/2 completed');
    expect(text).toContain('○ Do something');
    expect(text).not.toContain('○ Do something [');
    expect(text).toContain('✓ Do another thing');
    expect(text).not.toContain('✓ Do another thing [');
  });

  it('renders all status icons correctly', async () => {
    const result = await tool.execute('call-4', {
      todos: [
        { id: '1', content: 'Completed task', status: 'completed' },
        { id: '2', content: 'In progress task', status: 'in_progress' },
        { id: '3', content: 'Pending task', status: 'pending' },
      ],
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('✓ Completed task');
    expect(text).toContain('◉ In progress task');
    expect(text).toContain('○ Pending task');
  });

  it('returns empty details object', async () => {
    const result = await tool.execute('call-5', {
      todos: [{ id: '1', content: 'Task', status: 'pending' }],
    });

    expect(result.details).toEqual({});
  });
});
