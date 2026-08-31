import type {
  ConversationCreateRequest,
  ConversationPatchRequest,
  MobileApiError,
} from '@dash/mobile-contract';
import type { Hono } from 'hono';
import type { AgentRegistry } from './agent-registry.js';
import { type ConversationService, ConversationServiceError } from './conversation-service.js';
import type { EventBus } from './event-bus.js';

export interface ConversationRoutesOptions {
  conversations: ConversationService;
  agentRegistry: AgentRegistry;
  eventBus?: EventBus;
}

export function toMobileApiError(error: unknown): {
  status: 400 | 404 | 409 | 410 | 422 | 500;
  body: MobileApiError;
} {
  if (error instanceof ConversationServiceError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        error: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    status: 500,
    body: { code: 'gateway_offline', error: 'Internal gateway error', retryable: true },
  };
}

function validationError(message: string): ConversationServiceError {
  return new ConversationServiceError('validation_failed', message, 400, false);
}

export function parseIfMatch(value: string | undefined): number {
  const match = value?.match(/^"(0|[1-9][0-9]*)"$/);
  if (!match) {
    throw validationError('If-Match must contain the quoted conversation revision');
  }
  const revision = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(revision)) {
    throw validationError('If-Match must contain the quoted conversation revision');
  }
  return revision;
}

function requirePlainObject(value: unknown, message: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw validationError(message);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw validationError('Request body contains unknown fields');
  }
}

function requireNonblankString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError(`${field} must be a nonblank string`);
  }
  return value.trim();
}

const CREATE_KEYS = new Set(['agentId', 'requestId', 'title', 'owningIssueId', 'projectId']);

export function parseConversationCreateRequest(value: unknown): ConversationCreateRequest {
  const body = requirePlainObject(value, 'Conversation create body must be an object');
  assertOnlyKeys(body, CREATE_KEYS);
  const result: ConversationCreateRequest = {
    agentId: requireNonblankString(body.agentId, 'agentId'),
    requestId: requireNonblankString(body.requestId, 'requestId'),
  };
  for (const key of ['title', 'owningIssueId', 'projectId'] as const) {
    if (body[key] !== undefined) result[key] = requireNonblankString(body[key], key);
  }
  return result;
}

const PATCH_KEYS = new Set(['title', 'owningIssueId', 'projectId']);

export function parseConversationPatchRequest(value: unknown): ConversationPatchRequest {
  const body = requirePlainObject(value, 'Conversation patch body must be an object');
  assertOnlyKeys(body, PATCH_KEYS);
  const present = [...PATCH_KEYS].filter((key) => Object.hasOwn(body, key));
  if (present.length === 0) throw validationError('Conversation patch must not be empty');

  const patch: ConversationPatchRequest = {};
  if (Object.hasOwn(body, 'title')) {
    patch.title = requireNonblankString(body.title, 'title');
  }
  for (const key of ['owningIssueId', 'projectId'] as const) {
    if (!Object.hasOwn(body, key)) continue;
    const raw = body[key];
    patch[key] = raw === null ? null : requireNonblankString(raw, key);
  }
  return patch;
}

function urlFor(requestUrl: string): URL {
  return new URL(requestUrl);
}

function assertOnlyQueryKeys(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw validationError(`Unknown query parameter: ${key}`);
  }
}

function singleQueryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || values[0].length === 0) {
    throw validationError(`Query parameter ${key} must appear once with a value`);
  }
  return values[0];
}

function parseLimit(url: URL, defaultValue: number, max: number): number {
  const raw = singleQueryValue(url, 'limit');
  if (raw === undefined) return defaultValue;
  if (!/^[1-9][0-9]*$/.test(raw)) throw validationError('Invalid page limit');
  const limit = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(limit) || limit > max) throw validationError('Invalid page limit');
  return limit;
}

export function mountConversationRoutes(app: Hono, options: ConversationRoutesOptions): void {
  app.post('/conversations', async (c) => {
    try {
      const raw = await c.req.json<unknown>().catch(() => {
        throw validationError('Request body must be valid JSON');
      });
      const body = parseConversationCreateRequest(raw);
      const agent = options.agentRegistry.get(body.agentId);
      if (!agent) {
        throw new ConversationServiceError('not_found', 'Agent not found', 404, false);
      }
      const summary = options.conversations.create({ ...body, agentName: agent.name });
      options.eventBus?.emit({
        type: 'conversation:changed',
        conversationId: summary.id,
        revision: summary.revision,
      });
      c.header('ETag', `"${summary.revision}"`);
      return c.json(summary, 201);
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.get('/conversations', (c) => {
    try {
      const url = urlFor(c.req.url);
      assertOnlyQueryKeys(url, new Set(['agentId', 'limit', 'cursor']));
      const agentId = singleQueryValue(url, 'agentId');
      if (agentId !== undefined && agentId.trim().length === 0) {
        throw validationError('agentId must be a nonblank string');
      }
      const cursor = singleQueryValue(url, 'cursor');
      const page = options.conversations.list({
        limit: parseLimit(url, 50, 100),
        ...(agentId !== undefined ? { agentId: agentId.trim() } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return c.json(page);
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.get('/conversations/:id', (c) => {
    try {
      const summary = options.conversations.get(c.req.param('id'), { includeDeleted: true });
      if (!summary) {
        throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
      }
      c.header('ETag', `"${summary.revision}"`);
      return c.json(summary);
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.patch('/conversations/:id', async (c) => {
    try {
      const expectedRevision = parseIfMatch(c.req.header('If-Match'));
      const raw = await c.req.json<unknown>().catch(() => {
        throw validationError('Request body must be valid JSON');
      });
      const summary = options.conversations.update(
        c.req.param('id'),
        expectedRevision,
        parseConversationPatchRequest(raw),
      );
      options.eventBus?.emit({
        type: 'conversation:changed',
        conversationId: summary.id,
        revision: summary.revision,
      });
      c.header('ETag', `"${summary.revision}"`);
      return c.json(summary);
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.delete('/conversations/:id', (c) => {
    try {
      const summary = options.conversations.delete(
        c.req.param('id'),
        parseIfMatch(c.req.header('If-Match')),
      );
      options.eventBus?.emit({
        type: 'conversation:deleted',
        conversationId: summary.id,
        revision: summary.revision,
      });
      c.header('ETag', `"${summary.revision}"`);
      return c.json(summary);
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.get('/conversations/:id/messages', (c) => {
    try {
      const url = urlFor(c.req.url);
      assertOnlyQueryKeys(url, new Set(['limit', 'before']));
      const before = singleQueryValue(url, 'before');
      const page = options.conversations.listMessages({
        conversationId: c.req.param('id'),
        limit: parseLimit(url, 100, 200),
        ...(before !== undefined ? { before } : {}),
      });
      return c.json(page);
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });
}
