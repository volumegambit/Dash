import { ConversationServiceError } from './conversation-service.js';

interface ConversationCursorPayload {
  v: 1;
  updatedAt: string;
  id: string;
}

interface MessageCursorPayload {
  v: 1;
  ordinal: number;
  id: string;
}

const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function invalidCursor(): ConversationServiceError {
  return new ConversationServiceError('validation_failed', 'Invalid pagination cursor', 400, false);
}

function decode(cursor: string): unknown {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw invalidCursor();
    return JSON.parse(decoded.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ConversationServiceError) throw error;
    throw invalidCursor();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export function encodeConversationCursor(input: { updatedAt: string; id: string }): string {
  return encode({ v: 1, ...input } satisfies ConversationCursorPayload);
}

export function decodeConversationCursor(cursor: string): { updatedAt: string; id: string } {
  const value = decode(cursor);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['v', 'updatedAt', 'id']) ||
    value.v !== 1 ||
    typeof value.updatedAt !== 'string' ||
    !RFC_3339.test(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  ) {
    throw invalidCursor();
  }
  return { updatedAt: value.updatedAt, id: value.id };
}

export function encodeMessageCursor(input: { ordinal: number; id: string }): string {
  return encode({ v: 1, ...input } satisfies MessageCursorPayload);
}

export function decodeMessageCursor(cursor: string): { ordinal: number; id: string } {
  const value = decode(cursor);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['v', 'ordinal', 'id']) ||
    value.v !== 1 ||
    typeof value.ordinal !== 'number' ||
    !Number.isInteger(value.ordinal) ||
    value.ordinal <= 0 ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  ) {
    throw invalidCursor();
  }
  return { ordinal: value.ordinal, id: value.id };
}
