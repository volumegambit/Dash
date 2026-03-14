import type { LogEntry, LogFormatter } from './index.js';

/**
 * JSON formatter that outputs structured logs
 * Format: {"timestamp":"2026-03-08T12:34:56.789Z","level":"info","message":"test","correlationId":"abc123","component":"test","context":{}}
 */
export class JsonFormatter implements LogFormatter {
  private component?: string;

  constructor(component?: string) {
    this.component = component;
  }

  format(entry: LogEntry): string {
    const logObject: Record<string, unknown> = {
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
    };

    // Add correlation ID if available in context
    if (entry.context?.correlationId) {
      logObject.correlationId = entry.context.correlationId;
    }

    // Add component if configured
    if (this.component) {
      logObject.component = this.component;
    }

    // Add context, excluding correlationId to avoid duplication
    const context = entry.context ? { ...entry.context } : {};
    const { correlationId, ...contextWithoutCorrelationId } = context;

    if (Object.keys(contextWithoutCorrelationId).length > 0) {
      logObject.context = contextWithoutCorrelationId;
    }

    // Add error details if present
    if (entry.error) {
      logObject.error = {
        name: entry.error.name,
        message: entry.error.message,
        stack: entry.error.stack,
      };
    }

    return JSON.stringify(logObject);
  }
}

/**
 * Text formatter that outputs human-readable logs
 * Format: 2026-03-08T12:34:56.789Z [INFO] [test] test (abc123)
 */
export class TextFormatter implements LogFormatter {
  private component?: string;

  constructor(component?: string) {
    this.component = component;
  }

  format(entry: LogEntry): string {
    const timestamp = entry.timestamp;
    const level = entry.level.toUpperCase().padEnd(5);
    const component = this.component ? `[${this.component}]` : '';
    const correlationId = entry.context?.correlationId ? ` (${entry.context.correlationId})` : '';

    let logLine = `${timestamp} [${level}]${component ? ` ${component}` : ''} ${entry.message}${correlationId}`;

    // Add context information (excluding correlationId)
    const context = entry.context ? { ...entry.context } : {};
    const { correlationId: _, ...contextWithoutCorrelationId } = context;

    if (Object.keys(contextWithoutCorrelationId).length > 0) {
      logLine += ` ${JSON.stringify(contextWithoutCorrelationId)}`;
    }

    // Add error information
    if (entry.error) {
      logLine += `\nError: ${entry.error.message}`;
      if (entry.error.stack) {
        logLine += `\n${entry.error.stack}`;
      }
    }

    return logLine;
  }
}
