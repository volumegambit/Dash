import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { correlation } from './correlation.js';
import { JsonFormatter, TextFormatter } from './formatters.js';
import type { LogEntry, LogWriter } from './index.js';
import { StructuredLoggerImpl } from './logger.js';

/**
 * Test writer that captures every LogEntry it receives, exposing them as a
 * plain array so tests can make deep-equality assertions against the output.
 *
 * The production logger fires writes "fire-and-forget" (see logger.ts:136)
 * so tests must call `await writer.settle()` after a logger call to give
 * the microtask queue a chance to drain before asserting on `entries`.
 */
class CaptureWriter implements LogWriter {
  entries: LogEntry[] = [];
  flushCount = 0;
  closeCount = 0;

  async write(entry: LogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async flush(): Promise<void> {
    this.flushCount++;
  }

  async close(): Promise<void> {
    this.closeCount++;
  }

  /**
   * Drain any pending write promises scheduled via fire-and-forget. One
   * `await` cycles through the microtask queue; two is defensive for
   * writers that chain additional `await`s internally.
   */
  async settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  clear(): void {
    this.entries = [];
  }
}

// ── Output shape ─────────────────────────────────────────────────────────

describe('StructuredLoggerImpl — output shape', () => {
  let writer: CaptureWriter;

  beforeEach(() => {
    writer = new CaptureWriter();
  });

  it('emits a LogEntry with timestamp, level, message, and merged context', async () => {
    const logger = new StructuredLoggerImpl('info', [writer], { service: 'test-svc' });
    logger.info('user signed in', { userId: 42 });
    await writer.settle();

    expect(writer.entries).toHaveLength(1);
    const entry = writer.entries[0];
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('user signed in');
    // Default context (service) merged with per-call context (userId)
    expect(entry.context).toEqual({ service: 'test-svc', userId: 42 });
    // ISO-8601 timestamp
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('emits an entry with no context field when neither default nor call context is set', async () => {
    const logger = new StructuredLoggerImpl('info', [writer]);
    logger.info('bare message');
    await writer.settle();

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0].context).toBeUndefined();
    expect(writer.entries[0].message).toBe('bare message');
  });

  it('attaches the error object to entries emitted via logger.error', async () => {
    const logger = new StructuredLoggerImpl('info', [writer]);
    const boom = new Error('disk full');
    logger.error('write failed', boom, { path: '/var/log/app.log' });
    await writer.settle();

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0].level).toBe('error');
    expect(writer.entries[0].error).toBe(boom);
    expect(writer.entries[0].context).toEqual({ path: '/var/log/app.log' });
  });
});

// ── Level filtering ───────────────────────────────────────────────────────

describe('StructuredLoggerImpl — level filtering', () => {
  it('drops messages below the configured level', async () => {
    const writer = new CaptureWriter();
    // level='warn' should drop debug + info, keep warn + error
    const logger = new StructuredLoggerImpl('warn', [writer]);

    logger.debug('debug-should-drop');
    logger.info('info-should-drop');
    logger.warn('warn-should-keep');
    logger.error('error-should-keep', new Error('x'));
    await writer.settle();

    const messages = writer.entries.map((e) => e.message);
    expect(messages).toEqual(['warn-should-keep', 'error-should-keep']);
  });

  it('level="debug" emits every level (no filtering)', async () => {
    const writer = new CaptureWriter();
    const logger = new StructuredLoggerImpl('debug', [writer]);

    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    await writer.settle();

    expect(writer.entries.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('level="error" drops debug, info, and warn', async () => {
    const writer = new CaptureWriter();
    const logger = new StructuredLoggerImpl('error', [writer]);

    logger.debug('x');
    logger.info('x');
    logger.warn('x');
    logger.error('x');
    await writer.settle();

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0].level).toBe('error');
  });
});

// ── Child loggers ─────────────────────────────────────────────────────────

describe('StructuredLoggerImpl — child loggers', () => {
  it('child inherits parent default context and merges its own fields', async () => {
    const writer = new CaptureWriter();
    const parent = new StructuredLoggerImpl('info', [writer], { service: 'gateway' });
    const child = parent.child({ requestId: 'abc-123' });

    child.info('handling request');
    await writer.settle();

    expect(writer.entries[0].context).toEqual({
      service: 'gateway',
      requestId: 'abc-123',
    });
  });

  it('child context does not leak back to the parent', async () => {
    const writer = new CaptureWriter();
    const parent = new StructuredLoggerImpl('info', [writer], { service: 'gateway' });
    const child = parent.child({ requestId: 'abc' });

    child.info('child event');
    parent.info('parent event');
    await writer.settle();

    // Child entry has requestId; parent entry must not
    expect(writer.entries[0].context).toEqual({ service: 'gateway', requestId: 'abc' });
    expect(writer.entries[1].context).toEqual({ service: 'gateway' });
  });

  it('child shares the parent level filter', async () => {
    const writer = new CaptureWriter();
    const parent = new StructuredLoggerImpl('warn', [writer]);
    const child = parent.child({ requestId: 'abc' });

    child.info('should-drop');
    child.warn('should-keep');
    await writer.settle();

    expect(writer.entries).toHaveLength(1);
    expect(writer.entries[0].message).toBe('should-keep');
  });
});

// ── Correlation propagation ───────────────────────────────────────────────

describe('StructuredLoggerImpl — correlation propagation', () => {
  it('attaches the active correlation ID to entries logged inside correlation.run()', async () => {
    const writer = new CaptureWriter();
    const logger = new StructuredLoggerImpl('info', [writer]);

    correlation.run('req-42', () => {
      logger.info('inside correlation');
    });
    logger.info('outside correlation');
    await writer.settle();

    expect(writer.entries).toHaveLength(2);
    expect(writer.entries[0].context).toEqual({ correlationId: 'req-42' });
    // Outside the run(), no context should be attached at all
    expect(writer.entries[1].context).toBeUndefined();
  });

  it('propagates correlation ID through async boundaries', async () => {
    const writer = new CaptureWriter();
    const logger = new StructuredLoggerImpl('info', [writer]);

    await correlation.run('async-7', async () => {
      await Promise.resolve();
      logger.info('after microtask');
      await new Promise((resolve) => setTimeout(resolve, 1));
      logger.info('after timer');
    });
    await writer.settle();

    expect(writer.entries).toHaveLength(2);
    expect(writer.entries[0].context).toEqual({ correlationId: 'async-7' });
    expect(writer.entries[1].context).toEqual({ correlationId: 'async-7' });
  });
});

// ── Performance metrics ───────────────────────────────────────────────────

describe('StructuredLoggerImpl — performance metrics', () => {
  it('withMetricsAsync returns the wrapped function value and logs a "completed" entry', async () => {
    const writer = new CaptureWriter();
    const logger = new StructuredLoggerImpl('info', [writer], {}, true);

    const result = await logger.withMetricsAsync('db query', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rowsAffected: 3 };
    });
    await writer.settle();

    expect(result).toEqual({ rowsAffected: 3 });
    expect(writer.entries).toHaveLength(1);
    const entry = writer.entries[0];
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('db query completed');
    // duration should be present and non-negative
    const metrics = entry.context?.metrics as { duration: number } | undefined;
    expect(metrics).toBeDefined();
    expect(metrics?.duration).toBeGreaterThanOrEqual(0);
  });

  it('withMetricsAsync logs an error entry and rethrows when the wrapped function throws', async () => {
    const writer = new CaptureWriter();
    const logger = new StructuredLoggerImpl('info', [writer], {}, true);
    const boom = new Error('timeout');

    await expect(
      logger.withMetricsAsync('slow op', async () => {
        throw boom;
      }),
    ).rejects.toThrow('timeout');
    await writer.settle();

    expect(writer.entries).toHaveLength(1);
    const entry = writer.entries[0];
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('slow op failed');
    expect(entry.error).toBe(boom);
  });

  it('withMetrics (sync) skips metrics tracking when enablePerformanceMetrics is false', async () => {
    const writer = new CaptureWriter();
    // enablePerformanceMetrics = false (default)
    const logger = new StructuredLoggerImpl('info', [writer]);

    const result = logger.withMetrics('no-op', () => 42);
    await writer.settle();

    // With metrics disabled, nothing should be logged about the wrapped call
    expect(result).toBe(42);
    expect(writer.entries).toHaveLength(0);
  });
});

// ── Multi-writer fan-out + writer errors ──────────────────────────────────

describe('StructuredLoggerImpl — writer fan-out and error isolation', () => {
  it('writes every entry to every configured writer', async () => {
    const w1 = new CaptureWriter();
    const w2 = new CaptureWriter();
    const logger = new StructuredLoggerImpl('info', [w1, w2]);

    logger.info('replicate me');
    await w1.settle();
    await w2.settle();

    expect(w1.entries).toHaveLength(1);
    expect(w2.entries).toHaveLength(1);
    expect(w1.entries[0].message).toBe('replicate me');
    expect(w2.entries[0].message).toBe('replicate me');
  });

  it('a throwing writer does not prevent other writers from receiving the entry', async () => {
    const good = new CaptureWriter();
    const bad: LogWriter = {
      write: async () => {
        throw new Error('disk full');
      },
      flush: async () => {},
      close: async () => {},
    };
    // Silence the expected console.error from writeToAll's catch block
    const origError = console.error;
    console.error = () => {};

    try {
      const logger = new StructuredLoggerImpl('info', [bad, good]);
      logger.info('should still reach the good writer');
      await good.settle();

      expect(good.entries).toHaveLength(1);
      expect(good.entries[0].message).toBe('should still reach the good writer');
    } finally {
      console.error = origError;
    }
  });

  it('flush() and close() propagate to every configured writer', async () => {
    const w1 = new CaptureWriter();
    const w2 = new CaptureWriter();
    const logger = new StructuredLoggerImpl('info', [w1, w2]);

    await logger.flush();
    expect(w1.flushCount).toBe(1);
    expect(w2.flushCount).toBe(1);

    await logger.close();
    expect(w1.closeCount).toBe(1);
    expect(w2.closeCount).toBe(1);
  });
});

// ── Formatters ────────────────────────────────────────────────────────────

describe('Formatters — output shape for the same entry', () => {
  const sampleEntry: LogEntry = {
    timestamp: '2026-04-12T13:00:00.000Z',
    level: 'info',
    message: 'user signed in',
    context: { userId: 42, ip: '10.0.0.1' },
  };

  it('JsonFormatter produces valid JSON with expected keys and nested context', () => {
    const formatter = new JsonFormatter('auth-svc');
    const output = formatter.format(sampleEntry);
    const parsed = JSON.parse(output);

    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('user signed in');
    expect(parsed.timestamp).toBe('2026-04-12T13:00:00.000Z');
    expect(parsed.component).toBe('auth-svc');
    // Context keys are nested under `context` (not flattened to top-level)
    expect(parsed.context).toEqual({ userId: 42, ip: '10.0.0.1' });
  });

  it('JsonFormatter hoists correlationId from context to a top-level field', () => {
    const formatter = new JsonFormatter();
    const entry: LogEntry = {
      timestamp: '2026-04-12T13:00:00.000Z',
      level: 'info',
      message: 'with correlation',
      context: { correlationId: 'req-9', userId: 42 },
    };
    const parsed = JSON.parse(formatter.format(entry));
    expect(parsed.correlationId).toBe('req-9');
    // correlationId is NOT duplicated inside context
    expect(parsed.context).toEqual({ userId: 42 });
  });

  it('TextFormatter produces a single-line human-readable string', () => {
    const formatter = new TextFormatter('auth-svc');
    const output = formatter.format(sampleEntry);

    // Not JSON — should fail to parse as such
    expect(() => JSON.parse(output)).toThrow();

    // Should contain the level and message in plain text
    expect(output).toContain('INFO');
    expect(output).toContain('user signed in');
  });

  it('JsonFormatter and TextFormatter produce DIFFERENT strings for the same entry', () => {
    const json = new JsonFormatter('svc').format(sampleEntry);
    const text = new TextFormatter('svc').format(sampleEntry);
    expect(json).not.toBe(text);
  });
});

// ── Cleanup hygiene ───────────────────────────────────────────────────────

describe('StructuredLoggerImpl — cleanup', () => {
  let origError: typeof console.error;

  beforeEach(() => {
    origError = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    console.error = origError;
  });

  it('close() returns a promise that resolves even if a writer throws', async () => {
    const logger = new StructuredLoggerImpl('info', [
      {
        write: async () => {},
        flush: async () => {},
        close: async () => {
          throw new Error('close failed');
        },
      },
    ]);

    // Should not reject — errors are caught and console.error'd
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
