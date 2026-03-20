import { correlation } from './correlation.js';
import {
  addWebSocketCorrelationMetadata,
  createCorrelatedWebSocketHandler,
  getCurrentCorrelationId,
  getWebSocketCorrelationElapsedTime,
  withWebSocketCorrelation,
  withWebSocketCorrelationStream,
} from './websocket.js';

describe('WebSocket Correlation', () => {
  it('should extract correlation ID from message', async () => {
    const message = { id: 'test-msg-123', type: 'test' };
    let capturedId: string | undefined;

    await withWebSocketCorrelation(message, async () => {
      capturedId = getCurrentCorrelationId();
    });

    expect(capturedId).toBe('test-msg-123');
  });

  it('should generate correlation ID when not in message', async () => {
    const message = { type: 'test' }; // No id field
    let capturedId: string | undefined;

    await withWebSocketCorrelation(message, async () => {
      capturedId = getCurrentCorrelationId();
    });

    expect(capturedId).toBeDefined();
    expect(typeof capturedId).toBe('string');
    expect(capturedId?.length).toBeGreaterThan(0);
  });

  it('should add WebSocket metadata', async () => {
    const message = { id: 'test-123', type: 'chat' };
    let capturedMetadata: Record<string, unknown> | undefined;

    await withWebSocketCorrelation(message, async () => {
      capturedMetadata = correlation.getMetadata();
    });

    expect(capturedMetadata?.transport).toBe('websocket');
    expect(capturedMetadata?.messageType).toBe('chat');
  });

  it('should support custom correlation ID extraction', async () => {
    const message = { customId: 'custom-123', type: 'test' };
    let capturedId: string | undefined;

    await withWebSocketCorrelation(
      message,
      async () => {
        capturedId = getCurrentCorrelationId();
      },
      {
        extractCorrelationId: (msg: unknown) => {
          const m = msg as Record<string, unknown>;
          return m.customId as string;
        },
      },
    );

    expect(capturedId).toBe('custom-123');
  });

  it('should support custom metadata extraction', async () => {
    const message = { id: 'test-123', userId: '456', action: 'send' };
    let capturedMetadata: Record<string, unknown> | undefined;

    await withWebSocketCorrelation(
      message,
      async () => {
        capturedMetadata = correlation.getMetadata();
      },
      {
        extractMetadata: (msg: unknown) => {
          const m = msg as Record<string, unknown>;
          return { userId: m.userId, action: m.action };
        },
      },
    );

    expect(capturedMetadata?.userId).toBe('456');
    expect(capturedMetadata?.action).toBe('send');
  });

  it('should create correlated handler', async () => {
    let processedMessage: unknown;
    let handlerCorrelationId: string | undefined;

    const handler = createCorrelatedWebSocketHandler(async (message: unknown) => {
      processedMessage = message;
      handlerCorrelationId = getCurrentCorrelationId();
    });

    const message = { id: 'handler-test-123', type: 'test' };
    await handler(message);

    expect(processedMessage).toBe(message);
    expect(handlerCorrelationId).toBe('handler-test-123');
  });

  it('should handle streaming with correlation', async () => {
    const message = { id: 'stream-test-123', type: 'stream' };
    const chunks: Array<{ value: string; correlationId?: string }> = [];

    const stream = withWebSocketCorrelationStream(message, async function* () {
      for (let i = 0; i < 3; i++) {
        const correlationId = getCurrentCorrelationId();
        yield { value: `chunk-${i}`, correlationId };
      }
    });

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    chunks.forEach((chunk, i) => {
      expect(chunk.value).toBe(`chunk-${i}`);
      expect(chunk.correlationId).toBe('stream-test-123');
    });
  });

  it('should add metadata within WebSocket context', async () => {
    const message = { id: 'metadata-test-123', type: 'test' };

    await withWebSocketCorrelation(message, async () => {
      addWebSocketCorrelationMetadata({ userId: '789', sessionId: 'abc' });

      const metadata = correlation.getMetadata();
      expect(metadata?.userId).toBe('789');
      expect(metadata?.sessionId).toBe('abc');
      expect(metadata?.transport).toBe('websocket');
    });
  });

  it('should provide elapsed time', async () => {
    const message = { id: 'timing-test-123', type: 'test' };

    await withWebSocketCorrelation(message, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));

      const elapsed = getWebSocketCorrelationElapsedTime();
      expect(elapsed).toBeDefined();
      expect(typeof elapsed).toBe('number');
      expect(elapsed).toBeGreaterThan(0);
    });
  });

  it('should handle async generator errors gracefully', async () => {
    const message = { id: 'error-stream-test', type: 'stream' };

    const stream = withWebSocketCorrelationStream(message, async function* () {
      yield 'first-chunk';
      throw new Error('Stream error');
    });

    const chunks: string[] = [];
    let error: Error | undefined;

    try {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    } catch (err) {
      error = err as Error;
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('first-chunk');
    expect(error?.message).toBe('Stream error');
  });

  it('should maintain correlation across async operations', async () => {
    const message = { id: 'async-test-123', type: 'test' };
    const correlationIds: Array<string | undefined> = [];

    await withWebSocketCorrelation(message, async () => {
      correlationIds.push(getCurrentCorrelationId());

      await new Promise((resolve) => setTimeout(resolve, 5));
      correlationIds.push(getCurrentCorrelationId());

      await Promise.all([
        new Promise((resolve) => {
          setTimeout(() => {
            correlationIds.push(getCurrentCorrelationId());
            resolve(undefined);
          }, 5);
        }),
        new Promise((resolve) => {
          setTimeout(() => {
            correlationIds.push(getCurrentCorrelationId());
            resolve(undefined);
          }, 10);
        }),
      ]);
    });

    expect(correlationIds).toHaveLength(4);
    for (const id of correlationIds) {
      expect(id).toBe('async-test-123');
    }
  });
});
