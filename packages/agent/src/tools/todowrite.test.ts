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
        { id: '1', content: 'Set up database', status: 'completed' },
        { id: '2', content: 'Write API', status: 'in_progress' },
        { id: '3', content: 'Add tests', status: 'pending' },
      ],
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('1/3 completed');
    expect(text).toContain('✓ Set up database');
    expect(text).toContain('◉ Write API');
    expect(text).toContain('○ Add tests');
  });

  it('handles an empty todo list', async () => {
    const result = await tool.execute('call-2', { todos: [] });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('0/0 completed');
  });

  it('renders all status icons correctly', async () => {
    const result = await tool.execute('call-3', {
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
    const result = await tool.execute('call-4', {
      todos: [{ id: '1', content: 'Task', status: 'pending' }],
    });
    expect(result.details).toEqual({});
  });
});
