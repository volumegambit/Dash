import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LogEntry, LogFormatter, LogWriter } from './index.js';
import { type Counter, type Gauge, type Timer, defaultRegistry } from './metrics.js';
import { LogRotationManager, type RotationConfig, type RotationEvent } from './rotation.js';

/**
 * Configuration for the rotating stream writer
 */
export interface StreamWriterConfig {
  /** Path to the log file */
  filePath: string;
  /** Log formatter */
  formatter: LogFormatter;
  /** Rotation configuration */
  rotation?: Partial<RotationConfig>;
  /** Buffer configuration */
  buffer?: {
    /** Maximum buffer size in bytes before flushing */
    maxSize?: number;
    /** Maximum time in milliseconds before flushing */
    maxTime?: number;
    /** Whether to enable buffering */
    enabled?: boolean;
  };
  /** Whether to enable automatic rotation checks */
  autoRotate?: boolean;
  /** Rotation check interval in milliseconds */
  rotationCheckInterval?: number;
}

/**
 * Buffer entry for batched writes
 */
interface BufferEntry {
  content: string;
  timestamp: number;
}

/**
 * Enhanced file writer with rotation and buffering capabilities
 */
export class RotatingStreamWriter implements LogWriter {
  private config: StreamWriterConfig;
  private rotationManager?: LogRotationManager;
  private isInitialized = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private buffer: BufferEntry[] = [];
  private bufferSize = 0;
  private lastFlushTime = Date.now();
  private flushTimer?: NodeJS.Timeout;
  private rotationTimer?: NodeJS.Timeout;
  private closed = false;

  // Metrics
  private writeCounter: Counter;
  private bufferSizeGauge: Gauge;
  private flushCounter: Counter;
  private rotationEventCounter: Counter;
  private writeTimer: Timer;
  private bufferFlushTimer: Timer;

  constructor(config: StreamWriterConfig) {
    this.config = {
      buffer: {
        maxSize: 64 * 1024, // 64KB default
        maxTime: 5000, // 5 seconds default
        enabled: true,
        ...config.buffer,
      },
      autoRotate: true,
      rotationCheckInterval: 60000, // 1 minute default
      ...config,
    };

    // Initialize rotation manager if rotation is configured
    if (this.config.rotation) {
      this.rotationManager = new LogRotationManager({
        filePath: this.config.filePath,
        trigger: this.config.rotation.trigger || { maxSize: 10 * 1024 * 1024 },
        retention: this.config.rotation.retention || { compress: true, maxFiles: 30, maxDays: 30 },
        archiveDir: this.config.rotation.archiveDir,
      });
    }

    // Initialize metrics
    const labels = { file: this.config.filePath };
    this.writeCounter = defaultRegistry.getOrCreateCounter(
      'log_writes_total',
      'Total number of log writes',
      labels,
    );
    this.bufferSizeGauge = defaultRegistry.getOrCreateGauge(
      'log_buffer_size_bytes',
      'Current size of the log buffer in bytes',
      labels,
    );
    this.flushCounter = defaultRegistry.getOrCreateCounter(
      'log_flushes_total',
      'Total number of buffer flushes',
      labels,
    );
    this.rotationEventCounter = defaultRegistry.getOrCreateCounter(
      'log_rotation_events_total',
      'Total number of rotation events',
      labels,
    );
    this.writeTimer = defaultRegistry.getOrCreateTimer(
      'log_write_duration_seconds',
      'Time taken to write log entries',
      labels,
    );
    this.bufferFlushTimer = defaultRegistry.getOrCreateTimer(
      'log_buffer_flush_duration_seconds',
      'Time taken to flush the log buffer',
      labels,
    );

    this.setupTimers();
  }

  /**
   * Setup periodic timers for buffer flushing and rotation checks
   */
  private setupTimers(): void {
    // Buffer flush timer
    if (this.config.buffer?.enabled && this.config.buffer.maxTime) {
      this.flushTimer = setInterval(
        () => this.checkBufferFlush(),
        Math.min(this.config.buffer.maxTime / 2, 1000),
      );
    }

    // Rotation check timer
    if (this.config.autoRotate && this.rotationManager && this.config.rotationCheckInterval) {
      this.rotationTimer = setInterval(
        () => this.checkRotation(),
        this.config.rotationCheckInterval,
      );
    }
  }

  /**
   * Ensure the log directory exists
   */
  private async ensureDirectoryExists(): Promise<void> {
    if (this.isInitialized || this.closed) return;

    try {
      const dir = dirname(this.config.filePath);
      await mkdir(dir, { recursive: true });
      this.isInitialized = true;
    } catch (error) {
      throw new Error(
        `Failed to create log directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Write a log entry
   */
  async write(entry: LogEntry): Promise<void> {
    if (this.closed) {
      throw new Error('Writer is closed');
    }

    const timerEnd = this.writeTimer.startTimer();

    try {
      this.writeCounter.inc();
      const formatted = `${this.config.formatter.format(entry)}\n`;

      if (this.config.buffer?.enabled) {
        await this.writeToBuffer(formatted);
      } else {
        await this.writeDirectly(formatted);
      }
    } finally {
      timerEnd();
    }
  }

  /**
   * Write to buffer
   */
  private async writeToBuffer(content: string): Promise<void> {
    this.buffer.push({
      content,
      timestamp: Date.now(),
    });

    this.bufferSize += content.length;
    this.bufferSizeGauge.set(this.bufferSize);

    // Check if buffer should be flushed
    const maxSize = this.config.buffer?.maxSize || 0;
    if (this.bufferSize >= maxSize) {
      await this.flushBuffer();
    }
  }

  /**
   * Write directly to file (bypassing buffer)
   */
  private async writeDirectly(content: string): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureDirectoryExists();
      await this.writeToFile(content);
    });

    await this.writeQueue;
  }

  /**
   * Check if buffer should be flushed based on time
   */
  private async checkBufferFlush(): Promise<void> {
    if (this.buffer.length === 0 || this.closed) {
      return;
    }

    const maxTime = this.config.buffer?.maxTime || Number.MAX_SAFE_INTEGER;
    const timeSinceLastFlush = Date.now() - this.lastFlushTime;

    if (timeSinceLastFlush >= maxTime) {
      await this.flushBuffer();
    }
  }

  /**
   * Flush the buffer to disk
   */
  async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0 || this.closed) {
      return;
    }

    const timerEnd = this.bufferFlushTimer.startTimer();

    try {
      const currentBuffer = [...this.buffer];
      this.buffer = [];
      this.bufferSize = 0;
      this.lastFlushTime = Date.now();

      this.bufferSizeGauge.set(0);
      this.flushCounter.inc();

      const content = currentBuffer.map((entry) => entry.content).join('');

      this.writeQueue = this.writeQueue.then(async () => {
        await this.ensureDirectoryExists();
        await this.writeToFile(content);
      });

      await this.writeQueue;
    } finally {
      timerEnd();
    }
  }

  /**
   * Write content to file
   */
  private async writeToFile(content: string): Promise<void> {
    try {
      await appendFile(this.config.filePath, content, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to write to log file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Check if rotation is needed and perform it
   */
  private async checkRotation(): Promise<void> {
    if (!this.rotationManager || this.closed) {
      return;
    }

    try {
      // Flush any buffered content before rotation
      if (this.config.buffer?.enabled) {
        await this.flushBuffer();
      }

      const event = await this.rotationManager.checkAndRotate();
      if (event) {
        this.rotationEventCounter.inc();
        this.onRotationEvent(event);
      }
    } catch (error) {
      // Log rotation errors but don't fail the write operation
      console.error(
        `Log rotation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Handle rotation events
   */
  private onRotationEvent(event: RotationEvent): void {
    // Can be overridden by subclasses for custom rotation handling
  }

  /**
   * Force a rotation
   */
  async forceRotation(reason: 'size' | 'time' = 'size'): Promise<RotationEvent | null> {
    if (!this.rotationManager) {
      throw new Error('Rotation is not configured for this writer');
    }

    // Flush any buffered content before rotation
    if (this.config.buffer?.enabled) {
      await this.flushBuffer();
    }

    const event = await this.rotationManager.forceRotation(reason);
    if (event) {
      this.rotationEventCounter.inc();
      this.onRotationEvent(event);
    }

    return event;
  }

  /**
   * Get rotation status
   */
  async getRotationStatus(): Promise<{
    needsRotation: boolean;
    reason?: 'size' | 'time';
    currentSize?: number;
    lastRotation?: Date;
    archiveCount: number;
  } | null> {
    if (!this.rotationManager) {
      return null;
    }

    return this.rotationManager.getStatus();
  }

  /**
   * Flush all pending writes
   */
  async flush(): Promise<void> {
    if (this.closed) {
      return;
    }

    // Flush buffer if enabled
    if (this.config.buffer?.enabled) {
      await this.flushBuffer();
    }

    // Wait for any pending writes to complete
    await this.writeQueue;
  }

  /**
   * Close the writer
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    // Clear timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }

    // Flush any remaining content
    await this.flush();
  }

  /**
   * Get buffer statistics
   */
  getBufferStats(): {
    size: number;
    entries: number;
    timeSinceLastFlush: number;
    enabled: boolean;
  } {
    return {
      size: this.bufferSize,
      entries: this.buffer.length,
      timeSinceLastFlush: Date.now() - this.lastFlushTime,
      enabled: this.config.buffer?.enabled || false,
    };
  }

  /**
   * Update buffer configuration
   */
  updateBufferConfig(config: Partial<NonNullable<StreamWriterConfig['buffer']>>): void {
    if (this.closed) {
      throw new Error('Cannot update config on closed writer');
    }

    this.config.buffer = {
      ...this.config.buffer,
      ...config,
    };

    // Restart timers if needed
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    if (this.config.buffer.enabled && this.config.buffer.maxTime) {
      this.flushTimer = setInterval(
        () => this.checkBufferFlush(),
        Math.min(this.config.buffer.maxTime / 2, 1000),
      );
    }
  }

  /**
   * Get writer statistics
   */
  getStats(): {
    writes: number;
    flushes: number;
    rotations: number;
    bufferStats: {
      size: number;
      entries: number;
      timeSinceLastFlush: number;
      enabled: boolean;
    };
    isInitialized: boolean;
    isClosed: boolean;
  } {
    return {
      writes: this.writeCounter.getValue(),
      flushes: this.flushCounter.getValue(),
      rotations: this.rotationEventCounter.getValue(),
      bufferStats: this.getBufferStats(),
      isInitialized: this.isInitialized,
      isClosed: this.closed,
    };
  }
}

/**
 * Create a rotating stream writer with default configuration
 */
export function createRotatingWriter(
  filePath: string,
  formatter: LogFormatter,
  options: Partial<Omit<StreamWriterConfig, 'filePath' | 'formatter'>> = {},
): RotatingStreamWriter {
  return new RotatingStreamWriter({
    filePath,
    formatter,
    ...options,
  });
}

/**
 * Create a high-performance rotating writer optimized for high-volume logging
 */
export function createHighVolumeWriter(
  filePath: string,
  formatter: LogFormatter,
  options: Partial<Omit<StreamWriterConfig, 'filePath' | 'formatter'>> = {},
): RotatingStreamWriter {
  return new RotatingStreamWriter({
    filePath,
    formatter,
    buffer: {
      maxSize: 256 * 1024, // 256KB buffer
      maxTime: 10000, // 10 seconds
      enabled: true,
      ...options.buffer,
    },
    rotation: {
      trigger: {
        maxSize: 100 * 1024 * 1024, // 100MB files
        interval: 'daily',
      },
      retention: {
        maxFiles: 30,
        maxDays: 30,
        compress: true,
      },
      ...options.rotation,
    },
    autoRotate: true,
    rotationCheckInterval: 30000, // Check every 30 seconds
    ...options,
  });
}
