import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Context data stored in async local storage
 */
interface CorrelationContext {
  correlationId: string;
  startTime?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Correlation ID management using async_hooks for request tracing
 */
class CorrelationManager {
  private asyncLocalStorage = new AsyncLocalStorage<CorrelationContext>();

  /**
   * Get the current correlation ID from async context
   */
  getId(): string | undefined {
    const context = this.asyncLocalStorage.getStore();
    return context?.correlationId;
  }

  /**
   * Get the current correlation context
   */
  getContext(): CorrelationContext | undefined {
    return this.asyncLocalStorage.getStore();
  }

  /**
   * Set correlation ID and run callback within that context
   */
  run<T>(correlationId: string, callback: () => T): T {
    const context: CorrelationContext = {
      correlationId,
      startTime: Date.now(),
    };
    return this.asyncLocalStorage.run(context, callback);
  }

  /**
   * Set correlation ID and run async callback within that context
   */
  async runAsync<T>(correlationId: string, callback: () => Promise<T>): Promise<T> {
    const context: CorrelationContext = {
      correlationId,
      startTime: Date.now(),
    };
    return this.asyncLocalStorage.run(context, callback);
  }

  /**
   * Generate a new correlation ID and run callback within that context
   */
  runWithNewId<T>(callback: () => T): T {
    const correlationId = randomUUID();
    return this.run(correlationId, callback);
  }

  /**
   * Generate a new correlation ID and run async callback within that context
   */
  async runWithNewIdAsync<T>(callback: () => Promise<T>): Promise<T> {
    const correlationId = randomUUID();
    return this.runAsync(correlationId, callback);
  }

  /**
   * Add metadata to the current correlation context
   */
  addMetadata(metadata: Record<string, unknown>): void {
    const context = this.asyncLocalStorage.getStore();
    if (context) {
      context.metadata = { ...context.metadata, ...metadata };
    }
  }

  /**
   * Get metadata from the current correlation context
   */
  getMetadata(): Record<string, unknown> | undefined {
    const context = this.asyncLocalStorage.getStore();
    return context?.metadata;
  }

  /**
   * Get elapsed time since correlation context was created
   */
  getElapsedTime(): number | undefined {
    const context = this.asyncLocalStorage.getStore();
    if (context?.startTime) {
      return Date.now() - context.startTime;
    }
    return undefined;
  }

  /**
   * Generate a new correlation ID
   */
  generateId(): string {
    return randomUUID();
  }
}

// Export singleton instance
export const correlation = new CorrelationManager();

/**
 * Decorator for automatically wrapping functions with correlation ID
 */
export function withCorrelation<T extends (...args: unknown[]) => unknown>(
  target: T,
  correlationId?: string,
): T {
  return ((...args: unknown[]) => {
    const id = correlationId || correlation.generateId();
    return correlation.run(id, () => target(...args));
  }) as T;
}

/**
 * Decorator for automatically wrapping async functions with correlation ID
 */
export function withCorrelationAsync<T extends (...args: unknown[]) => Promise<unknown>>(
  target: T,
  correlationId?: string,
): T {
  return (async (...args: unknown[]) => {
    const id = correlationId || correlation.generateId();
    return correlation.runAsync(id, () => target(...args));
  }) as T;
}
