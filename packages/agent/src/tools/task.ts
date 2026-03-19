import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const taskSchema = Type.Object({
  action: Type.Union(
    [Type.Literal('create'), Type.Literal('update'), Type.Literal('list'), Type.Literal('get')],
    { description: 'The action to perform on tasks' },
  ),
  subject: Type.Optional(Type.String({ description: 'Task subject/title (required for create)' })),
  description: Type.Optional(
    Type.String({ description: 'Task description with details (for create)' }),
  ),
  taskId: Type.Optional(
    Type.String({ description: 'Task ID to operate on (required for update and get)' }),
  ),
  status: Type.Optional(
    Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')], {
      description: 'New status for the task (required for update)',
    }),
  ),
});

type TaskInput = Static<typeof taskSchema>;

type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface Task {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
}

/** Format the full task list as a summary string */
function formatTaskList(tasks: Map<string, Task>): string {
  if (tasks.size === 0) {
    return 'Tasks (0/0 completed):\n(no tasks)';
  }

  const all = Array.from(tasks.values());
  const completedCount = all.filter((t) => t.status === 'completed').length;
  const header = `Tasks (${completedCount}/${all.length} completed):`;
  const lines = all.map((t) => `#${t.id}. [${t.status}] ${t.subject}`);
  return `${header}\n${lines.join('\n')}`;
}

/**
 * Create the task tool.
 * Manages an in-memory list of tasks with auto-incrementing IDs.
 */
export function createTaskTool(): AgentTool<typeof taskSchema> {
  const tasks = new Map<string, Task>();
  let nextId = 1;

  return {
    name: 'task',
    label: 'Task',
    description:
      'Track and manage work progress. Create tasks, update their status, list all tasks, or get details of a specific task.',
    parameters: taskSchema,
    execute: async (
      _toolCallId: string,
      params: TaskInput,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      switch (params.action) {
        case 'create': {
          if (!params.subject) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: subject is required for create action.',
                },
              ],
              details: {},
            };
          }

          const id = String(nextId++);
          const task: Task = {
            id,
            subject: params.subject,
            status: 'pending',
          };
          if (params.description) {
            task.description = params.description;
          }
          tasks.set(id, task);

          return {
            content: [
              {
                type: 'text',
                text: `Task #${id} created.\n\n${formatTaskList(tasks)}`,
              },
            ],
            details: {},
          };
        }

        case 'list': {
          return {
            content: [
              {
                type: 'text',
                text: formatTaskList(tasks),
              },
            ],
            details: {},
          };
        }

        case 'get': {
          if (!params.taskId) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: taskId is required for get action.',
                },
              ],
              details: {},
            };
          }

          const task = tasks.get(params.taskId);
          if (!task) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: Task #${params.taskId} not found.\n\n${formatTaskList(tasks)}`,
                },
              ],
              details: {},
            };
          }

          const lines = [`#${task.id}. [${task.status}] ${task.subject}`];
          if (task.description) {
            lines.push(`Description: ${task.description}`);
          }

          return {
            content: [
              {
                type: 'text',
                text: lines.join('\n'),
              },
            ],
            details: {},
          };
        }

        case 'update': {
          if (!params.taskId) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: taskId is required for update action.',
                },
              ],
              details: {},
            };
          }

          const task = tasks.get(params.taskId);
          if (!task) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: Task #${params.taskId} not found.\n\n${formatTaskList(tasks)}`,
                },
              ],
              details: {},
            };
          }

          if (params.status) {
            task.status = params.status;
          }

          return {
            content: [
              {
                type: 'text',
                text: `Task #${task.id} updated.\n\n${formatTaskList(tasks)}`,
              },
            ],
            details: {},
          };
        }
      }
    },
  };
}
