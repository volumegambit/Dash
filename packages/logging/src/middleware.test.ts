import { Hono } from 'hono';
import { correlation } from './correlation.js';
import {
  type CorrelationMiddlewareOptions,
  addCorrelationMetadata,
  correlationMiddleware,
  defaultCorrelationMiddleware,
  getCorrelationElapsedTime,
  getCurrentCorrelationId,
} from './middleware.js';

describe('Correlation Middleware', () => {
  it('should generate correlation ID when none provided', async () => {
    const app = new Hono();
    app.use('*', defaultCorrelationMiddleware);
    app.get('/', (c) => {
      const id = getCurrentCorrelationId();
      return c.json({ correlationId: id });
    });

    const req = new Request('http://localhost/');
    const res = await app.request(req);
    const data = await res.json();

    expect(data.correlationId).toBeDefined();
    expect(typeof data.correlationId).toBe('string');
    expect(data.correlationId.length).toBeGreaterThan(0);
  });

  it('should use correlation ID from header', async () => {
    const app = new Hono();
    app.use('*', defaultCorrelationMiddleware);
    app.get('/', (c) => {
      const id = getCurrentCorrelationId();
      return c.json({ correlationId: id });
    });

    const testId = 'test-correlation-123';
    const req = new Request('http://localhost/', {
      headers: { 'X-Correlation-ID': testId },
    });
    const res = await app.request(req);
    const data = await res.json();

    expect(data.correlationId).toBe(testId);
    expect(res.headers.get('X-Correlation-ID')).toBe(testId);
  });

  it('should use correlation ID from query parameter', async () => {
    const app = new Hono();
    app.use('*', defaultCorrelationMiddleware);
    app.get('/', (c) => {
      const id = getCurrentCorrelationId();
      return c.json({ correlationId: id });
    });

    const testId = 'query-correlation-456';
    const req = new Request(`http://localhost/?correlationId=${testId}`);
    const res = await app.request(req);
    const data = await res.json();

    expect(data.correlationId).toBe(testId);
  });

  it('should prefer header over query parameter', async () => {
    const app = new Hono();
    app.use('*', defaultCorrelationMiddleware);
    app.get('/', (c) => {
      const id = getCurrentCorrelationId();
      return c.json({ correlationId: id });
    });

    const headerId = 'header-correlation-789';
    const queryId = 'query-correlation-123';
    const req = new Request(`http://localhost/?correlationId=${queryId}`, {
      headers: { 'X-Correlation-ID': headerId },
    });
    const res = await app.request(req);
    const data = await res.json();

    expect(data.correlationId).toBe(headerId);
  });

  it('should include timing information when enabled', async () => {
    const app = new Hono();
    app.use('*', correlationMiddleware({ includeTiming: true }));
    app.get('/', async (c) => {
      // Add small delay to ensure timing
      await new Promise((resolve) => setTimeout(resolve, 10));
      return c.json({ ok: true });
    });

    const req = new Request('http://localhost/');
    const res = await app.request(req);

    const responseTime = res.headers.get('X-Response-Time');
    expect(responseTime).toBeDefined();
    expect(typeof responseTime).toBe('string');
    expect(responseTime).toMatch(/^\d+ms$/);
  });

  it('should allow custom configuration', async () => {
    const customId = 'custom-123';
    const options: CorrelationMiddlewareOptions = {
      headerName: 'X-Trace-ID',
      queryParam: 'traceId',
      generateId: () => customId,
      extractMetadata: (c) => ({ method: c.req.method }),
    };

    const app = new Hono();
    app.use('*', correlationMiddleware(options));
    app.get('/', (c) => {
      const id = getCurrentCorrelationId();
      const metadata = correlation.getMetadata();
      return c.json({ correlationId: id, metadata });
    });

    const req = new Request('http://localhost/');
    const res = await app.request(req);
    const data = await res.json();

    expect(data.correlationId).toBe(customId);
    expect(data.metadata?.method).toBe('GET');
    expect(res.headers.get('X-Trace-ID')).toBe(customId);
  });

  it('should handle errors gracefully', async () => {
    const app = new Hono();
    app.use('*', defaultCorrelationMiddleware);
    app.get('/', () => {
      throw new Error('Test error');
    });

    const testId = 'error-test-correlation';
    const req = new Request('http://localhost/', {
      headers: { 'X-Correlation-ID': testId },
    });

    // The error should be thrown but correlation ID should still be in response
    try {
      await app.request(req);
    } catch (error) {
      // Expected to throw
    }

    // Create a version that handles the error
    const appWithErrorHandler = new Hono();
    appWithErrorHandler.use('*', defaultCorrelationMiddleware);
    appWithErrorHandler.get('/', () => {
      throw new Error('Test error');
    });
    appWithErrorHandler.onError((err, c) => {
      return c.json({ error: err.message }, 500);
    });

    const res = await appWithErrorHandler.request(req);
    expect(res.headers.get('X-Correlation-ID')).toBe(testId);
  });

  it('should add metadata within request context', async () => {
    const app = new Hono();
    app.use('*', defaultCorrelationMiddleware);
    app.get('/', (c) => {
      addCorrelationMetadata({ userId: '123', action: 'test' });
      const metadata = correlation.getMetadata();
      return c.json({ metadata });
    });

    const req = new Request('http://localhost/');
    const res = await app.request(req);
    const data = await res.json();

    expect(data.metadata?.userId).toBe('123');
    expect(data.metadata?.action).toBe('test');
    expect(data.metadata?.method).toBe('GET');
    expect(data.metadata?.path).toBe('/');
  });

  it('should provide elapsed time within request', async () => {
    const app = new Hono();
    app.use('*', defaultCorrelationMiddleware);
    app.get('/', async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const elapsed = getCorrelationElapsedTime();
      return c.json({ elapsed });
    });

    const req = new Request('http://localhost/');
    const res = await app.request(req);
    const data = await res.json();

    expect(data.elapsed).toBeDefined();
    expect(typeof data.elapsed).toBe('number');
    expect(data.elapsed).toBeGreaterThan(0);
  });

  it('should not include response header when disabled', async () => {
    const app = new Hono();
    app.use('*', correlationMiddleware({ includeInResponse: false }));
    app.get('/', (c) => c.json({ ok: true }));

    const req = new Request('http://localhost/');
    const res = await app.request(req);

    expect(res.headers.get('X-Correlation-ID')).toBeNull();
  });
});
