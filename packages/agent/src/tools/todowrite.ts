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
 * Create the task tool.
 * Accepts a structured task list and returns a formatted text summary.
 * The agent sends the complete list each time — this replaces the previous state.
 * This is a core tool, always registered by the backend.
 */
export function createTodoWriteTool(): AgentTool<typeof todoSchema> {
  return {
    name: 'task',
    label: 'Task',
    description:
      'Track and manage work with a structured task list. Send the complete list each time — this replaces the previous state. Use this to track progress on multi-step work.',
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
        lines.push(`${icon} ${todo.content}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {},
      };
    },
  };
}
