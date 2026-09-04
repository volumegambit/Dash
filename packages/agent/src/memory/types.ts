export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** Who wrote the memory: the agent via a tool, the post-turn sweep, a human via the API, or the legacy import. */
export type MemorySource = 'agent' | 'sweep' | 'user' | 'import';

export interface MemoryRecord {
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  /** ISO date (YYYY-MM-DD). */
  createdAt: string;
  updatedAt: string;
  content: string;
}

export interface MemoryInfo extends Omit<MemoryRecord, 'content'> {
  /** Body length in characters. */
  size: number;
}

export interface SaveMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
}

export type MemoryOpCode = 'invalid' | 'limit' | 'not_found';

export class MemoryOpError extends Error {
  constructor(
    public readonly code: MemoryOpCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryOpError';
  }
}

export const MEMORY_LIMITS = {
  nameMax: 64,
  descriptionMax: 200,
  contentMax: 2048,
  importContentMax: 8192,
  perAgent: 200,
  indexMaxChars: 4000,
  recallLimit: 5,
} as const;

export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}
