/**
 * Example integration patterns for correlation middleware
 *
 * This file contains example code showing how to integrate the correlation
 * middleware with existing Hono servers in the Dash project.
 *
 * These examples are for documentation purposes and are not exported
 * as part of the public API.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  addCorrelationMetadata,
  correlationMiddleware,
  defaultCorrelationMiddleware,
  getCurrentCorrelationId,
  withWebSocketCorrelation,
  withWebSocketCorrelationStream,
} from './index.js';

/**
 * Example: Management server with correlation middleware
 */
function createExampleManagementServer() {
  const app = new Hono();

  // Add correlation middleware before other middleware
  app.use('*', defaultCorrelationMiddleware);

  // Existing auth middleware (correlation context is maintained)
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') {
      await next();
      return;
    }
    const auth = c.req.header('Authorization');
    if (!auth || auth !== 'Bearer token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Routes automatically have correlation context
  app.get('/info', (c) => {
    const correlationId = getCurrentCorrelationId();
    console.log('Processing /info request', { correlationId });

    // Add custom metadata
    addCorrelationMetadata({ endpoint: 'info', userId: 'admin' });

    return c.json({ status: 'ok', correlationId });
  });

  app.get('/health', (c) => {
    // Even public endpoints get correlation IDs
    const correlationId = getCurrentCorrelationId();
    return c.json({ status: 'healthy', correlationId });
  });

  return app;
}

/**
 * Example: Chat server with WebSocket correlation
 */
function createExampleChatServer() {
  const app = new Hono();
  const { upgradeWebSocket } = createNodeWebSocket({ app });

  // HTTP endpoints use middleware
  app.use(
    '*',
    correlationMiddleware({
      includeInResponse: true,
      includeTiming: true,
      extractMetadata: (c) => ({
        userAgent: c.req.header('User-Agent'),
        endpoint: c.req.path,
      }),
    }),
  );

  // WebSocket endpoint with correlation
  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const token = c.req.query('token');
      if (!token) {
        return {
          onOpen(_event, ws) {
            ws.close(4001, 'Unauthorized');
          },
        };
      }

      return {
        onMessage(event, ws) {
          const raw = typeof event.data === 'string' ? event.data : '';
          let message: unknown;
          try {
            message = JSON.parse(raw);
          } catch {
            ws.send(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }

          // Wrap message processing with correlation
          withWebSocketCorrelation(message, async () => {
            // All operations in this block have correlation context
            const correlationId = getCurrentCorrelationId();
            console.log('Processing WebSocket message', {
              correlationId,
              messageType:
                typeof message === 'object' && message !== null
                  ? (message as Record<string, unknown>).type
                  : 'unknown',
            });

            // Simulate message processing
            await processMessage(message);

            // Send response (correlation ID is maintained)
            ws.send(
              JSON.stringify({
                type: 'response',
                correlationId,
                status: 'processed',
              }),
            );
          }).catch((error) => {
            ws.send(
              JSON.stringify({
                type: 'error',
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          });
        },
      };
    }),
  );

  return app;
}

/**
 * Example: Custom middleware configuration
 */
function createCustomCorrelationMiddleware() {
  return correlationMiddleware({
    // Use custom header name
    headerName: 'X-Trace-ID',

    // Also check query parameter
    queryParam: 'traceId',

    // Include timing information in response
    includeTiming: true,

    // Extract additional metadata from request
    extractMetadata: (c) => ({
      method: c.req.method,
      path: c.req.path,
      userAgent: c.req.header('User-Agent'),
      remoteAddr: c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP'),
      contentType: c.req.header('Content-Type'),
    }),

    // Custom ID generator (e.g., shorter IDs)
    generateId: () => Math.random().toString(36).substring(2, 15),
  });
}

/**
 * Example: Streaming WebSocket with correlation
 */
function createExampleStreamingHandler() {
  const { upgradeWebSocket } = createNodeWebSocket({ app: new Hono() });

  return upgradeWebSocket((c: any) => ({
    onMessage(event: any, ws: any) {
      const message = JSON.parse(event.data as string);

      // For streaming responses, use withWebSocketCorrelationStream
      if (message.type === 'stream') {
        (async () => {
          const stream = withWebSocketCorrelationStream(message, async function* () {
            // This generator runs with correlation context
            for (let i = 0; i < 10; i++) {
              const correlationId = getCurrentCorrelationId();
              yield {
                type: 'chunk',
                id: message.id,
                data: `Chunk ${i}`,
                correlationId,
              };
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          });

          for await (const chunk of stream) {
            ws.send(JSON.stringify(chunk));
          }

          ws.send(
            JSON.stringify({
              type: 'done',
              id: message.id,
              correlationId: getCurrentCorrelationId(),
            }),
          );
        })();
      }
    },
  }));
}

// Helper function for examples
async function processMessage(message: unknown): Promise<void> {
  // Simulate async processing
  await new Promise((resolve) => setTimeout(resolve, 10));
}
