import type { ConversationPatchRequest } from '@dash/mobile-contract';
import type { MobileV2ReplayPage } from '@dash/mobile-contract-v2';
import type { Handler, Hono } from 'hono';
import type { AgentRegistry } from './agent-registry.js';
import {
  assertOnlyQueryKeys,
  parseConversationCreateRequest,
  parseConversationPatchRequest,
  parseIfMatch,
  parseLimit,
  singleQueryValue,
  toMobileApiError,
  validationError,
} from './conversation-routes.js';
import { type ConversationService, ConversationServiceError } from './conversation-service.js';
import type { EventBus } from './event-bus.js';

export interface ConversationV2RoutesOptions {
  conversations: ConversationService;
  agentRegistry: AgentRegistry;
  eventBus?: EventBus;
}

function mappedError(c: Parameters<Handler>[0], error: unknown): Response {
  const mapped = toMobileApiError(error);
  return c.json(mapped.body, mapped.status);
}

function readJson(c: Parameters<Handler>[0]): Promise<unknown> {
  return c.req.json<unknown>().catch(() => {
    throw validationError('Request body must be valid JSON');
  });
}

function requiredPathParam(c: Parameters<Handler>[0], name: string): string {
  const value = c.req.param(name);
  if (value === undefined) {
    throw validationError(`Missing path parameter: ${name}`);
  }
  return value;
}

function messagesHandler(options: ConversationV2RoutesOptions): Handler {
  return (c) => {
    try {
      const url = new URL(c.req.url);
      assertOnlyQueryKeys(url, new Set(['limit', 'before']));
      const before = singleQueryValue(url, 'before');
      const page = options.conversations.listMessagesV2({
        conversationId: requiredPathParam(c, 'id'),
        limit: parseLimit(url, 100, 200),
        ...(before !== undefined ? { before } : {}),
      });
      return c.json(page);
    } catch (error) {
      return mappedError(c, error);
    }
  };
}

function bootstrapHandler(options: ConversationV2RoutesOptions): Handler {
  return (c) => {
    try {
      const url = new URL(c.req.url);
      assertOnlyQueryKeys(url, new Set(['limit', 'before']));
      const before = singleQueryValue(url, 'before');
      const page = options.conversations.bootstrapV2({
        conversationId: requiredPathParam(c, 'id'),
        limit: parseLimit(url, 100, 200),
        ...(before !== undefined ? { before } : {}),
      });
      return c.json(page);
    } catch (error) {
      return mappedError(c, error);
    }
  };
}

function replayHandler(options: ConversationV2RoutesOptions): Handler {
  return (c) => {
    try {
      const url = new URL(c.req.url);
      assertOnlyQueryKeys(url, new Set(['sinceV2Seq']));
      const raw = singleQueryValue(url, 'sinceV2Seq');
      if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw validationError('sinceV2Seq must be a non-negative safe integer');
      }
      const sinceV2Seq = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(sinceV2Seq)) {
        throw validationError('sinceV2Seq must be a non-negative safe integer');
      }
      const result = options.conversations.readV2Since(
        requiredPathParam(c, 'agentId'),
        requiredPathParam(c, 'conversationId'),
        sinceV2Seq,
      );
      return c.json({
        frames: result.frames,
        v2ThroughSeq: result.throughSeq,
      } satisfies MobileV2ReplayPage);
    } catch (error) {
      return mappedError(c, error);
    }
  };
}

/** Mount the complete lossless conversation surface below `/mobile/v2`. */
export function mountConversationV2Routes(app: Hono, options: ConversationV2RoutesOptions): void {
  app.post('/conversations', async (c) => {
    try {
      const body = parseConversationCreateRequest(await readJson(c));
      const agent = options.agentRegistry.get(body.agentId);
      if (!agent) throw new ConversationServiceError('not_found', 'Agent not found', 404, false);
      const summary = options.conversations.createV2({ ...body, agentName: agent.name });
      options.eventBus?.emit({
        type: 'conversation:changed',
        conversationId: summary.id,
        revision: summary.revision,
      });
      c.header('ETag', `"${summary.revision}"`);
      return c.json(summary, 201);
    } catch (error) {
      return mappedError(c, error);
    }
  });

  app.get('/conversations', (c) => {
    try {
      const url = new URL(c.req.url);
      assertOnlyQueryKeys(url, new Set(['agentId', 'limit', 'cursor']));
      const agentId = singleQueryValue(url, 'agentId');
      if (agentId !== undefined && agentId.trim().length === 0) {
        throw validationError('agentId must be a nonblank string');
      }
      const cursor = singleQueryValue(url, 'cursor');
      return c.json(
        options.conversations.listV2({
          limit: parseLimit(url, 50, 100),
          ...(agentId !== undefined ? { agentId: agentId.trim() } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      );
    } catch (error) {
      return mappedError(c, error);
    }
  });

  app.get('/conversations/:id', (c) => {
    try {
      const summary = options.conversations.getV2(c.req.param('id'), { includeDeleted: true });
      if (!summary) {
        throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
      }
      c.header('ETag', `"${summary.revision}"`);
      return c.json(summary);
    } catch (error) {
      return mappedError(c, error);
    }
  });

  app.patch('/conversations/:id', async (c) => {
    try {
      const expectedRevision = parseIfMatch(c.req.header('If-Match'));
      const patch: ConversationPatchRequest = parseConversationPatchRequest(await readJson(c));
      const summary = options.conversations.updateV2(c.req.param('id'), expectedRevision, patch);
      options.eventBus?.emit({
        type: 'conversation:changed',
        conversationId: summary.id,
        revision: summary.revision,
      });
      c.header('ETag', `"${summary.revision}"`);
      return c.json(summary);
    } catch (error) {
      return mappedError(c, error);
    }
  });

  app.delete('/conversations/:id', (c) => {
    try {
      const summary = options.conversations.deleteV2(
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
      return mappedError(c, error);
    }
  });

  app.get('/conversations/:id/messages', messagesHandler(options));
  app.get('/conversations/:id/bootstrap', bootstrapHandler(options));
  app.get('/agents/:agentId/conversations/:conversationId/events', replayHandler(options));
}

/** Mount the noncolliding management-auth aliases consumed by Mission Control. */
export function mountConversationV2ManagementRoutes(
  app: Hono,
  options: ConversationV2RoutesOptions,
): void {
  app.get('/conversations/:id/messages-v2', messagesHandler(options));
  app.get('/conversations/:id/bootstrap', bootstrapHandler(options));
  app.get('/agents/:agentId/conversations/:conversationId/events-v2', replayHandler(options));
}
