import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { correlation } from './correlation.js';

/**
 * Options for correlation ID middleware
 */
export interface CorrelationMiddlewareOptions {
  /**
   * Header name to extract correlation ID from
   * @default 'X-Correlation-ID'
   */
  headerName?: string;

  /**
   * Query parameter name to extract correlation ID from
   * @default 'correlationId'
   */
  queryParam?: string;

  /**
   * Whether to add correlation ID to response headers
   * @default true
   */
  includeInResponse?: boolean;

  /**
   * Whether to include timing information in response headers
   * @default false
   */
  includeTiming?: boolean;

  /**
   * Custom function to generate correlation IDs
   * @default randomUUID
   */
  generateId?: () => string;

  /**
   * Function to extract additional metadata from the request
   */
  extractMetadata?: (c: Context) => Record<string, unknown>;
}

/**
 * Hono middleware for correlation ID management
 *
 * Extracts correlation ID from request headers or query parameters,
 * generates a new one if not present, and ensures all subsequent
 * processing runs within the correlation context.
 */
export function correlationMiddleware(
  options: CorrelationMiddlewareOptions = {},
): MiddlewareHandler {
  const {
    headerName = 'X-Correlation-ID',
    queryParam = 'correlationId',
    includeInResponse = true,
    includeTiming = false,
    generateId = randomUUID,
    extractMetadata,
  } = options;

  return async (c: Context, next) => {
    // Extract correlation ID from header or query param, or generate new one
    const correlationId = c.req.header(headerName) || c.req.query(queryParam) || generateId();

    let elapsedTime: number | undefined;

    try {
      // Run the request processing within correlation context
      await correlation.runAsync(correlationId, async () => {
        // Extract metadata if function provided
        if (extractMetadata) {
          const metadata = extractMetadata(c);
          if (metadata && Object.keys(metadata).length > 0) {
            correlation.addMetadata(metadata);
          }
        }

        // Add basic request metadata
        correlation.addMetadata({
          method: c.req.method,
          path: c.req.path,
          userAgent: c.req.header('User-Agent'),
          remoteAddr: c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP'),
        });

        // Process the request
        await next();

        // Capture timing information while still in correlation context
        if (includeTiming) {
          elapsedTime = correlation.getElapsedTime();
        }
      });

      // Add correlation ID to response headers
      if (includeInResponse) {
        c.res.headers.set(headerName, correlationId);
      }

      // Add timing information if requested
      if (includeTiming && elapsedTime !== undefined) {
        c.res.headers.set('X-Response-Time', `${elapsedTime}ms`);
      }
    } catch (error) {
      // Ensure correlation ID is in response even if there's an error
      if (includeInResponse) {
        c.res.headers.set(headerName, correlationId);
      }

      // Add timing information even on error if available
      if (includeTiming && elapsedTime !== undefined) {
        c.res.headers.set('X-Response-Time', `${elapsedTime}ms`);
      }

      // Re-throw the error to let Hono's error handling take over
      throw error;
    }
  };
}

/**
 * Default correlation middleware with standard configuration
 */
export const defaultCorrelationMiddleware = correlationMiddleware({
  headerName: 'X-Correlation-ID',
  queryParam: 'correlationId',
  includeInResponse: true,
  includeTiming: false,
});

/**
 * Correlation middleware with timing information
 */
export const correlationWithTimingMiddleware = correlationMiddleware({
  headerName: 'X-Correlation-ID',
  queryParam: 'correlationId',
  includeInResponse: true,
  includeTiming: true,
});

/**
 * Get the current correlation ID from within a Hono handler
 * This function can be called from within route handlers to get
 * the correlation ID set by the middleware.
 */
export function getCurrentCorrelationId(): string | undefined {
  return correlation.getId();
}

/**
 * Add metadata to the current correlation context
 * This function can be called from within route handlers to add
 * additional metadata to the correlation context.
 */
export function addCorrelationMetadata(metadata: Record<string, unknown>): void {
  correlation.addMetadata(metadata);
}

/**
 * Get elapsed time since the correlation context was created
 * This function can be called from within route handlers to get
 * timing information.
 */
export function getCorrelationElapsedTime(): number | undefined {
  return correlation.getElapsedTime();
}
