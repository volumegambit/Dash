import { correlation } from './correlation.js';

/**
 * Options for WebSocket correlation wrapper
 */
export interface WebSocketCorrelationOptions {
  /**
   * Function to extract correlation ID from WebSocket message
   * @default (msg) => msg?.id
   */
  extractCorrelationId?: (message: unknown) => string | undefined;

  /**
   * Function to extract metadata from WebSocket message
   */
  extractMetadata?: (message: unknown) => Record<string, unknown> | undefined;

  /**
   * Custom function to generate correlation IDs when not present in message
   * @default correlation.generateId
   */
  generateId?: () => string;
}

/**
 * Wraps WebSocket message processing with correlation context
 *
 * This function ensures that all processing for a WebSocket message
 * runs within a correlation context, using either the message's ID
 * or generating a new correlation ID.
 *
 * @param message - The WebSocket message
 * @param handler - Async function to process the message
 * @param options - Configuration options
 * @returns Promise that resolves when message processing is complete
 *
 * @example
 * ```typescript
 * // In WebSocket message handler
 * onMessage(event, ws) {
 *   const message = JSON.parse(event.data);
 *
 *   await withWebSocketCorrelation(message, async () => {
 *     // Process message - all operations will have correlation context
 *     const result = await someAsyncOperation();
 *     ws.send(JSON.stringify({ id: message.id, result }));
 *   });
 * }
 * ```
 */
export async function withWebSocketCorrelation<T>(
  message: unknown,
  handler: () => Promise<T>,
  options: WebSocketCorrelationOptions = {},
): Promise<T> {
  const {
    extractCorrelationId = (msg: unknown) => {
      if (typeof msg === 'object' && msg !== null) {
        const m = msg as Record<string, unknown>;
        return typeof m.id === 'string' ? m.id : undefined;
      }
      return undefined;
    },
    extractMetadata,
    generateId = () => correlation.generateId(),
  } = options;

  // Extract or generate correlation ID
  const correlationId = extractCorrelationId(message) || generateId();

  // Run handler within correlation context
  return correlation.runAsync(correlationId, async () => {
    // Add WebSocket-specific metadata
    correlation.addMetadata({
      transport: 'websocket',
      messageType:
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>).type
          : undefined,
    });

    // Extract custom metadata if function provided
    if (extractMetadata) {
      const metadata = extractMetadata(message);
      if (metadata && Object.keys(metadata).length > 0) {
        correlation.addMetadata(metadata);
      }
    }

    return handler();
  });
}

/**
 * Creates a correlation-aware WebSocket message handler
 *
 * This is a higher-order function that wraps a message handler
 * to automatically provide correlation context for each message.
 *
 * @param handler - The original message handler
 * @param options - Configuration options
 * @returns A new message handler that includes correlation context
 *
 * @example
 * ```typescript
 * // Create correlation-aware handler
 * const handleMessage = createCorrelatedWebSocketHandler(
 *   async (message, ws) => {
 *     // This runs with correlation context automatically
 *     const correlationId = getCurrentCorrelationId();
 *     logger.info('Processing message', { correlationId });
 *
 *     // Process the message
 *     await processMessage(message);
 *
 *     // Send response
 *     ws.send(JSON.stringify({ id: message.id, status: 'success' }));
 *   }
 * );
 *
 * // Use in WebSocket setup
 * upgradeWebSocket((c) => ({
 *   onMessage(event, ws) {
 *     const message = JSON.parse(event.data);
 *     handleMessage(message, ws);
 *   }
 * }))
 * ```
 */
export function createCorrelatedWebSocketHandler<T extends unknown[], R>(
  handler: (...args: T) => Promise<R>,
  options: WebSocketCorrelationOptions = {},
): (...args: T) => Promise<R> {
  return async (...args: T) => {
    // Assume first argument is the message for correlation extraction
    const message = args[0];

    return withWebSocketCorrelation(message, () => handler(...args), options);
  };
}

/**
 * Wraps an async generator (stream) with correlation context
 *
 * This is useful for streaming operations in WebSocket handlers
 * where you want to maintain correlation context throughout
 * the entire stream.
 *
 * @param message - The WebSocket message that initiated the stream
 * @param generator - Async generator function to wrap
 * @param options - Configuration options
 * @returns A new async generator with correlation context
 *
 * @example
 * ```typescript
 * // In WebSocket message handler for streaming
 * if (msg.type === 'stream') {
 *   const stream = withWebSocketCorrelationStream(msg, async function* () {
 *     for await (const chunk of someAsyncGenerator()) {
 *       yield { id: msg.id, chunk };
 *     }
 *   });
 *
 *   for await (const event of stream) {
 *     ws.send(JSON.stringify(event));
 *   }
 * }
 * ```
 */
export async function* withWebSocketCorrelationStream<T>(
  message: unknown,
  generator: () => AsyncGenerator<T>,
  options: WebSocketCorrelationOptions = {},
): AsyncGenerator<T> {
  const {
    extractCorrelationId = (msg: unknown) => {
      if (typeof msg === 'object' && msg !== null) {
        const m = msg as Record<string, unknown>;
        return typeof m.id === 'string' ? m.id : undefined;
      }
      return undefined;
    },
    extractMetadata,
    generateId = () => correlation.generateId(),
  } = options;

  // Extract or generate correlation ID
  const correlationId = extractCorrelationId(message) || generateId();

  // Initialize correlation context and metadata
  correlation.run(correlationId, () => {
    // Add WebSocket-specific metadata
    correlation.addMetadata({
      transport: 'websocket',
      messageType:
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>).type
          : undefined,
      streaming: true,
    });

    // Extract custom metadata if function provided
    if (extractMetadata) {
      const metadata = extractMetadata(message);
      if (metadata && Object.keys(metadata).length > 0) {
        correlation.addMetadata(metadata);
      }
    }
  });

  // Create the wrapped generator that maintains correlation context
  const wrappedGenerator = generator();

  try {
    while (true) {
      const result = await correlation.runAsync(correlationId, async () => {
        return wrappedGenerator.next();
      });

      if (result.done) {
        break;
      }

      yield result.value;
    }
  } finally {
    // Clean up the generator
    if (typeof wrappedGenerator.return === 'function') {
      await correlation.runAsync(correlationId, () => wrappedGenerator.return(undefined));
    }
  }
}

/**
 * Get the current correlation ID from within a WebSocket handler
 * This function can be called from within WebSocket handlers to get
 * the correlation ID set by withWebSocketCorrelation.
 */
export function getCurrentCorrelationId(): string | undefined {
  return correlation.getId();
}

/**
 * Add metadata to the current correlation context
 * This function can be called from within WebSocket handlers to add
 * additional metadata to the correlation context.
 */
export function addWebSocketCorrelationMetadata(metadata: Record<string, unknown>): void {
  correlation.addMetadata(metadata);
}

/**
 * Get elapsed time since the correlation context was created
 * This function can be called from within WebSocket handlers to get
 * timing information.
 */
export function getWebSocketCorrelationElapsedTime(): number | undefined {
  return correlation.getElapsedTime();
}
