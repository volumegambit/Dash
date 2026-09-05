import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { MemoryStore } from './store.js';
import { MEMORY_LIMITS, MemoryOpError, type MemoryType } from './types.js';

export const MEMORY_TOOL_NAMES = ['save_memory', 'recall_memory', 'forget_memory'] as const;

export type MemoryToolDetails =
  | {
      memory: {
        name: string;
        description: string;
        memoryType: MemoryType;
        action: 'created' | 'updated';
      };
    }
  | { memory: { name: string; action: 'forgotten' } }
  | Record<string, never>;

function textResult(
  text: string,
  details: MemoryToolDetails = {},
): AgentToolResult<MemoryToolDetails> {
  return { content: [{ type: 'text', text }], details };
}

function errorText(err: unknown): string {
  if (err instanceof MemoryOpError) return `Error: ${err.message}`;
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

const saveSchema = Type.Object({
  name: Type.String({
    description:
      'Stable slug for this fact (lowercase letters, digits, hyphens; max 64). Reuse an existing name to update it.',
  }),
  description: Type.String({
    description: `One line (max ${MEMORY_LIMITS.descriptionMax} chars) shown in the index — write it so a future turn can tell whether to recall this memory.`,
  }),
  type: Type.Union(
    [
      Type.Literal('user'),
      Type.Literal('feedback'),
      Type.Literal('project'),
      Type.Literal('reference'),
    ],
    {
      description:
        'user = who the user is; feedback = how they want you to work; project = ongoing work/constraints; reference = pointer to an external resource',
    },
  ),
  content: Type.String({
    description: `The fact itself, markdown, max ${MEMORY_LIMITS.contentMax} chars. For feedback/project include **Why:** and **How to apply:** lines.`,
  }),
});
type SaveInput = Static<typeof saveSchema>;

const nameSchema = Type.Object({
  name: Type.String({ description: 'The memory name from the index' }),
});
type NameInput = Static<typeof nameSchema>;

export function createSaveMemoryTool(store: MemoryStore): AgentTool<typeof saveSchema> {
  return {
    name: 'save_memory',
    label: 'Save Memory',
    description:
      'Save or update one memory that should persist across conversations. Check the memory index first and reuse the existing name to update rather than duplicate. Never store secrets.',
    parameters: saveSchema,
    execute: async (_toolCallId: string, params: SaveInput) => {
      try {
        const { record, action } = await store.save({ ...params, source: 'agent' });
        return textResult(`Saved memory "${record.name}" (${action}).`, {
          memory: {
            name: record.name,
            description: record.description,
            memoryType: record.type,
            action,
          },
        });
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };
}

export function createRecallMemoryTool(store: MemoryStore): AgentTool<typeof nameSchema> {
  return {
    name: 'recall_memory',
    label: 'Recall Memory',
    description: 'Read the full content of one memory from the index by name.',
    parameters: nameSchema,
    execute: async (_toolCallId: string, params: NameInput) => {
      const record = await store.get(params.name);
      if (!record) {
        const names = (await store.list()).map((m) => m.name).join(', ') || '(none)';
        return textResult(`Memory "${params.name}" not found. Known memories: ${names}`);
      }
      return textResult(
        `# ${record.name} (${record.type})\n${record.description}\n\n${record.content}`,
      );
    },
  };
}

export function createForgetMemoryTool(store: MemoryStore): AgentTool<typeof nameSchema> {
  return {
    name: 'forget_memory',
    label: 'Forget Memory',
    description:
      'Delete one memory by name when it is wrong or no longer applies. Memories the user wrote themselves cannot be deleted this way.',
    parameters: nameSchema,
    execute: async (_toolCallId: string, params: NameInput) => {
      // Tool-level guard, deliberately NOT in the store: the HTTP DELETE route
      // is the user deleting their own memory on purpose and must keep working.
      const existing = await store.get(params.name);
      if (existing && (existing.source === 'user' || existing.source === 'import')) {
        return textResult(
          `Memory "${params.name}" was written by the user, so you cannot delete it. If you believe it is wrong or out of date, raise it with them instead of deleting it.`,
        );
      }
      const removed = await store.remove(params.name);
      if (!removed) return textResult(`Memory "${params.name}" not found.`);
      return textResult(`Forgot memory "${params.name}".`, {
        memory: { name: params.name, action: 'forgotten' },
      });
    },
  };
}
