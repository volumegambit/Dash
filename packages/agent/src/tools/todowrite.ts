import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const todoSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      id: Type.String({ description: 'Unique ID' }),
      content: Type.String({ description: 'Todo item text' }),
      status: Type.Union([
        Type.Literal('pending'),
        Type.Literal('in_progress'),
        Type.Literal('completed'),
      ]),
      priority: Type.Optional(
        Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
      ),
    }),
  ),
});

type TodoWriteInput = Static<typeof todoSchema>;

const STATUS_ICONS: Record<string, string> = {
  completed: '✓',
  in_progress: '◉',
  pending: '○',
};

/**
 * Create the todowrite tool.
 * Accepts a structured todo list and returns a formatted text summary.
 */
export function createTodoWriteTool(): AgentTool<typeof todoSchema> {
  return {
    name: 'todowrite',
    label: 'Todo List',
    description:
      'Write a structured to-do list. Send the complete list each time — this replaces the previous state.',
    parameters: todoSchema,
    execute: async (
      _toolCallId: string,
      params: TodoWriteInput,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const { todos } = params;

      if (todos.length === 0) {
        return {
          content: [{ type: 'text', text: '0/0 completed' }],
          details: {},
        };
      }

      const completedCount = todos.filter((t) => t.status === 'completed').length;
      const total = todos.length;

      const lines: string[] = [`${completedCount}/${total} completed`];

      for (const todo of todos) {
        const icon = STATUS_ICONS[todo.status] ?? '○';
        const priorityLabel = todo.priority ? ` [${todo.priority}]` : '';
        lines.push(`${icon} ${todo.content}${priorityLabel}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {},
      };
    },
  };
}
