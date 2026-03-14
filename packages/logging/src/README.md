# Correlation ID Middleware for Dash

This package now includes correlation ID middleware for Hono-based HTTP servers and utilities for WebSocket correlation management.

## HTTP Middleware

### Basic Usage

```typescript
import { Hono } from 'hono';
import { defaultCorrelationMiddleware } from '@dash/logging';

const app = new Hono();

// Add correlation middleware before other middleware
app.use('*', defaultCorrelationMiddleware);

app.get('/', (c) => {
  // Correlation ID is automatically available in all route handlers
  const correlationId = getCurrentCorrelationId();
  return c.json({ correlationId });
});
```

### Custom Configuration

```typescript
import { correlationMiddleware } from '@dash/logging';

const customMiddleware = correlationMiddleware({
  headerName: 'X-Trace-ID',           // Custom header name
  queryParam: 'traceId',             // Query parameter name
  includeInResponse: true,           // Add header to response
  includeTiming: true,               // Add X-Response-Time header
  extractMetadata: (c) => ({         // Extract custom metadata
    userId: c.req.header('X-User-ID'),
    endpoint: c.req.path,
  }),
  generateId: () => 'custom-id',     // Custom ID generator
});

app.use('*', customMiddleware);
```

### Integration with Existing Servers

For the Management API server:

```typescript
// In packages/management/src/server.ts
import { defaultCorrelationMiddleware } from '@dash/logging';

export function createManagementApp(options: ManagementServerOptions): Hono {
  const app = new Hono();

  // Add correlation middleware first
  app.use('*', defaultCorrelationMiddleware);

  // Existing auth middleware comes after
  app.use('*', async (c, next) => {
    // ... existing auth logic
  });

  // Routes automatically have correlation context
  app.get('/info', (c) => {
    // Log with correlation ID
    logger.info('Processing /info request');
    return c.json(options.getInfo());
  });

  return app;
}
```

## WebSocket Correlation

### Basic Usage

```typescript
import { withWebSocketCorrelation } from '@dash/logging';

// In WebSocket message handler
onMessage(event, ws) {
  const message = JSON.parse(event.data);
  
  await withWebSocketCorrelation(message, async () => {
    // All operations here have correlation context
    const correlationId = getCurrentCorrelationId();
    
    // Process message
    await processMessage(message);
    
    // Send response
    ws.send(JSON.stringify({
      id: message.id,
      correlationId,
      result: 'success'
    }));
  });
}
```

### Streaming with Correlation

```typescript
import { withWebSocketCorrelationStream } from '@dash/logging';

if (msg.type === 'stream') {
  const stream = withWebSocketCorrelationStream(msg, async function* () {
    for await (const chunk of someAsyncGenerator()) {
      yield { id: msg.id, chunk, correlationId: getCurrentCorrelationId() };
    }
  });
  
  for await (const event of stream) {
    ws.send(JSON.stringify(event));
  }
}
```

### Create Correlated Handler

```typescript
import { createCorrelatedWebSocketHandler } from '@dash/logging';

const handleMessage = createCorrelatedWebSocketHandler(
  async (message, ws) => {
    // Automatic correlation context
    logger.info('Processing WebSocket message');
    await processMessage(message);
  }
);

// Use in WebSocket setup
upgradeWebSocket((c) => ({
  onMessage(event, ws) {
    const message = JSON.parse(event.data);
    handleMessage(message, ws);
  }
}))
```

## Available Functions

### HTTP Middleware
- `correlationMiddleware(options?)` - Configurable correlation middleware
- `defaultCorrelationMiddleware` - Pre-configured middleware with defaults
- `correlationWithTimingMiddleware` - Middleware with timing information
- `getCurrentCorrelationId()` - Get correlation ID in route handlers
- `addCorrelationMetadata(metadata)` - Add metadata to correlation context
- `getCorrelationElapsedTime()` - Get elapsed time since request started

### WebSocket Utilities
- `withWebSocketCorrelation(message, handler, options?)` - Wrap handler with correlation
- `createCorrelatedWebSocketHandler(handler, options?)` - Create correlation-aware handler
- `withWebSocketCorrelationStream(message, generator, options?)` - Correlation for async generators
- `getCurrentCorrelationId()` - Get correlation ID in WebSocket handlers
- `addWebSocketCorrelationMetadata(metadata)` - Add metadata to WebSocket correlation
- `getWebSocketCorrelationElapsedTime()` - Get elapsed time in WebSocket handlers

## Features

1. **Automatic ID Generation**: Creates UUID correlation IDs when not provided
2. **Multiple ID Sources**: Extracts from headers, query parameters, or WebSocket message IDs
3. **Response Headers**: Optionally includes correlation ID in HTTP response headers
4. **Timing Information**: Optional request timing via `X-Response-Time` header
5. **Metadata Collection**: Automatic and custom metadata extraction
6. **Error Handling**: Graceful error handling that preserves correlation context
7. **WebSocket Support**: Full correlation support for WebSocket message processing
8. **Streaming Support**: Maintains correlation context across async generators
9. **TypeScript Support**: Full type safety with TypeScript definitions

## Integration Points

The correlation middleware integrates with the existing `correlation` system from `packages/logging/src/correlation.ts`. All logging operations within the correlation context will automatically include the correlation ID when using the structured logger.

This allows for end-to-end request tracing across HTTP requests, WebSocket messages, tool executions, and async operations.