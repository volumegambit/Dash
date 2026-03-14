import { correlation } from './correlation.js';
import type { LogEntry, LogLevel, LogWriter, Logger } from './index.js';

/**
 * Performance metrics for optional timing and memory tracking
 */
interface PerformanceMetrics {
  duration?: number;
  memoryUsage?: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

/**
 * Extended logger interface with performance tracking
 */
export interface StructuredLogger extends Logger {
  /**
   * Log with performance metrics
   */
  withMetrics<T>(message: string, fn: () => T, context?: Record<string, unknown>): T;
  withMetricsAsync<T>(
    message: string,
    fn: () => Promise<T>,
    context?: Record<string, unknown>,
  ): Promise<T>;

  /**
   * Create a child logger with additional context
   */
  child(context: Record<string, unknown>): StructuredLogger;

  /**
   * Flush all writers
   */
  flush(): Promise<void>;

  /**
   * Close all writers
   */
  close(): Promise<void>;
}

/**
 * Log level hierarchy for filtering
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Main logger implementation with correlation tracking and performance metrics
 */
export class StructuredLoggerImpl implements StructuredLogger {
  private level: LogLevel;
  private writers: LogWriter[];
  private defaultContext: Record<string, unknown>;
  private enablePerformanceMetrics: boolean;

  constructor(
    level: LogLevel,
    writers: LogWriter[],
    defaultContext: Record<string, unknown> = {},
    enablePerformanceMetrics = false,
  ) {
    this.level = level;
    this.writers = writers;
    this.defaultContext = defaultContext;
    this.enablePerformanceMetrics = enablePerformanceMetrics;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error,
  ): LogEntry {
    const now = new Date().toISOString();
    const correlationId = correlation.getId();
    const correlationMetadata = correlation.getMetadata();

    // Merge all context sources
    const mergedContext: Record<string, unknown> = {
      ...this.defaultContext,
      ...correlationMetadata,
      ...context,
    };

    // Add correlation ID if available
    if (correlationId) {
      mergedContext.correlationId = correlationId;
    }

    return {
      timestamp: now,
      level,
      message,
      context: Object.keys(mergedContext).length > 0 ? mergedContext : undefined,
      error,
    };
  }

  private async writeToAll(entry: LogEntry): Promise<void> {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    // Write to all writers in parallel, catching individual errors
    const writePromises = this.writers.map(async (writer) => {
      try {
        await writer.write(entry);
      } catch (error) {
        // Log writer errors to console to avoid losing them
        console.error(
          `Logger writer error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });

    await Promise.all(writePromises);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    const entry = this.createLogEntry('debug', message, context);
    // Fire and forget for performance
    this.writeToAll(entry).catch(() => {
      // Already handled in writeToAll
    });
  }

  info(message: string, context?: Record<string, unknown>): void {
    const entry = this.createLogEntry('info', message, context);
    this.writeToAll(entry).catch(() => {
      // Already handled in writeToAll
    });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    const entry = this.createLogEntry('warn', message, context);
    this.writeToAll(entry).catch(() => {
      // Already handled in writeToAll
    });
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    const entry = this.createLogEntry('error', message, context, error);
    this.writeToAll(entry).catch(() => {
      // Already handled in writeToAll
    });
  }

  withMetrics<T>(message: string, fn: () => T, context?: Record<string, unknown>): T {
    if (!this.enablePerformanceMetrics) {
      return fn();
    }

    const startTime = performance.now();
    const startMemory = process.memoryUsage();

    try {
      const result = fn();
      const metrics = this.calculateMetrics(startTime, startMemory);
      this.info(`${message} completed`, { ...context, metrics });
      return result;
    } catch (error) {
      const metrics = this.calculateMetrics(startTime, startMemory);
      this.error(`${message} failed`, error instanceof Error ? error : new Error(String(error)), {
        ...context,
        metrics,
      });
      throw error;
    }
  }

  async withMetricsAsync<T>(
    message: string,
    fn: () => Promise<T>,
    context?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.enablePerformanceMetrics) {
      return fn();
    }

    const startTime = performance.now();
    const startMemory = process.memoryUsage();

    try {
      const result = await fn();
      const metrics = this.calculateMetrics(startTime, startMemory);
      this.info(`${message} completed`, { ...context, metrics });
      return result;
    } catch (error) {
      const metrics = this.calculateMetrics(startTime, startMemory);
      this.error(`${message} failed`, error instanceof Error ? error : new Error(String(error)), {
        ...context,
        metrics,
      });
      throw error;
    }
  }

  private calculateMetrics(startTime: number, startMemory: NodeJS.MemoryUsage): PerformanceMetrics {
    const endTime = performance.now();
    const endMemory = process.memoryUsage();

    return {
      duration: Math.round(endTime - startTime),
      memoryUsage: {
        rss: endMemory.rss - startMemory.rss,
        heapUsed: endMemory.heapUsed - startMemory.heapUsed,
        heapTotal: endMemory.heapTotal - startMemory.heapTotal,
        external: endMemory.external - startMemory.external,
      },
    };
  }

  child(context: Record<string, unknown>): StructuredLogger {
    return new StructuredLoggerImpl(
      this.level,
      this.writers,
      { ...this.defaultContext, ...context },
      this.enablePerformanceMetrics,
    );
  }

  async flush(): Promise<void> {
    const flushPromises = this.writers.map(async (writer) => {
      try {
        await writer.flush();
      } catch (error) {
        console.error(
          `Logger flush error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });

    await Promise.all(flushPromises);
  }

  async close(): Promise<void> {
    const closePromises = this.writers.map(async (writer) => {
      try {
        await writer.close();
      } catch (error) {
        console.error(
          `Logger close error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });

    await Promise.all(closePromises);
  }
}
