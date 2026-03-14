import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { type Counter, type Gauge, defaultRegistry } from './metrics.js';

/**
 * Time-based rotation intervals
 */
export type RotationInterval = 'hourly' | 'daily' | 'weekly' | 'monthly';

/**
 * Rotation trigger types
 */
export interface RotationTrigger {
  /** Maximum file size in bytes before rotation */
  maxSize?: number;
  /** Time-based rotation interval */
  interval?: RotationInterval;
}

/**
 * Retention policy for old log files
 */
export interface RetentionPolicy {
  /** Maximum number of archived files to keep */
  maxFiles?: number;
  /** Maximum age of archived files in days */
  maxDays?: number;
  /** Whether to compress archived files */
  compress?: boolean;
}

/**
 * Configuration for log rotation
 */
export interface RotationConfig {
  /** File path of the active log file */
  filePath: string;
  /** Rotation triggers */
  trigger: RotationTrigger;
  /** Retention policy for archived files */
  retention: RetentionPolicy;
  /** Directory for archived files (defaults to same as active file) */
  archiveDir?: string;
}

/**
 * Information about a rotation event
 */
export interface RotationEvent {
  /** Path of the file that was rotated */
  filePath: string;
  /** Path of the archived file */
  archivePath: string;
  /** Size of the rotated file in bytes */
  fileSize: number;
  /** Reason for rotation */
  reason: 'size' | 'time';
  /** Timestamp of the rotation */
  timestamp: Date;
  /** Whether the file was compressed */
  compressed: boolean;
}

/**
 * Log file rotation manager
 */
export class LogRotationManager {
  private config: RotationConfig;
  private lastRotationCheck: Date = new Date();
  private rotationInProgress = false;
  private rotationLock: Promise<RotationEvent | null> = Promise.resolve(null);

  // Metrics
  private rotationCounter: Counter;
  private compressionCounter: Counter;
  private cleanupCounter: Counter;
  private rotationDurationGauge: Gauge;
  private archiveFilesGauge: Gauge;

  constructor(config: RotationConfig) {
    this.config = {
      ...config,
      archiveDir: config.archiveDir || dirname(config.filePath),
      retention: {
        compress: true,
        maxFiles: 100,
        maxDays: 30,
        ...config.retention,
      },
      trigger: {
        maxSize: 10 * 1024 * 1024, // 10MB default
        ...config.trigger,
      },
    };

    // Initialize metrics
    const labels = { file: basename(this.config.filePath) };
    this.rotationCounter = defaultRegistry.getOrCreateCounter(
      'log_rotations_total',
      'Total number of log rotations performed',
      labels,
    );
    this.compressionCounter = defaultRegistry.getOrCreateCounter(
      'log_compressions_total',
      'Total number of log files compressed',
      labels,
    );
    this.cleanupCounter = defaultRegistry.getOrCreateCounter(
      'log_cleanups_total',
      'Total number of old log files cleaned up',
      labels,
    );
    this.rotationDurationGauge = defaultRegistry.getOrCreateGauge(
      'log_rotation_duration_seconds',
      'Duration of the last log rotation in seconds',
      labels,
    );
    this.archiveFilesGauge = defaultRegistry.getOrCreateGauge(
      'log_archive_files_count',
      'Number of archived log files',
      labels,
    );
  }

  /**
   * Check if rotation is needed and perform it if necessary
   */
  async checkAndRotate(): Promise<RotationEvent | null> {
    // Ensure only one rotation can happen at a time
    const result = this.rotationLock.then(async () => {
      if (this.rotationInProgress) {
        return null;
      }

      try {
        this.rotationInProgress = true;
        return await this.performRotationCheck();
      } finally {
        this.rotationInProgress = false;
      }
    });

    this.rotationLock = result;
    return result;
  }

  /**
   * Perform rotation check and execute if needed
   */
  private async performRotationCheck(): Promise<RotationEvent | null> {
    const reason = await this.needsRotation();
    if (!reason) {
      return null;
    }

    const startTime = performance.now();
    const event = await this.rotateFile(reason);
    const duration = (performance.now() - startTime) / 1000;

    this.rotationDurationGauge.set(duration);
    this.rotationCounter.inc();

    // Perform cleanup after rotation
    await this.cleanupOldFiles();

    return event;
  }

  /**
   * Check if rotation is needed
   */
  private async needsRotation(): Promise<'size' | 'time' | null> {
    try {
      const stats = await stat(this.config.filePath);

      // Check size-based rotation
      if (this.config.trigger.maxSize && stats.size >= this.config.trigger.maxSize) {
        return 'size';
      }

      // Check time-based rotation
      if (this.config.trigger.interval) {
        const now = new Date();
        if (this.shouldRotateByTime(stats.mtime, now, this.config.trigger.interval)) {
          return 'time';
        }
      }

      return null;
    } catch (error) {
      // File doesn't exist or can't be accessed, no rotation needed
      return null;
    }
  }

  /**
   * Check if time-based rotation is needed
   */
  private shouldRotateByTime(
    fileTime: Date,
    currentTime: Date,
    interval: RotationInterval,
  ): boolean {
    const getIntervalStart = (date: Date, interval: RotationInterval): Date => {
      const result = new Date(date);

      switch (interval) {
        case 'hourly':
          result.setMinutes(0, 0, 0);
          break;
        case 'daily':
          result.setHours(0, 0, 0, 0);
          break;
        case 'weekly':
          result.setDate(result.getDate() - result.getDay());
          result.setHours(0, 0, 0, 0);
          break;
        case 'monthly':
          result.setDate(1);
          result.setHours(0, 0, 0, 0);
          break;
      }

      return result;
    };

    const fileIntervalStart = getIntervalStart(fileTime, interval);
    const currentIntervalStart = getIntervalStart(currentTime, interval);

    return fileIntervalStart.getTime() !== currentIntervalStart.getTime();
  }

  /**
   * Rotate the log file
   */
  private async rotateFile(reason: 'size' | 'time'): Promise<RotationEvent> {
    const stats = await stat(this.config.filePath);
    const timestamp = new Date();
    const archivePath = this.generateArchivePath(timestamp, reason);

    // Ensure archive directory exists
    await mkdir(dirname(archivePath), { recursive: true });

    // Move current file to archive location
    await rename(this.config.filePath, archivePath);

    let finalArchivePath = archivePath;
    let compressed = false;

    // Compress if enabled
    if (this.config.retention.compress === true) {
      const compressedPath = `${archivePath}.gz`;
      await this.compressFile(archivePath, compressedPath);
      await unlink(archivePath);
      finalArchivePath = compressedPath;
      compressed = true;
      this.compressionCounter.inc();
    }

    return {
      filePath: this.config.filePath,
      archivePath: finalArchivePath,
      fileSize: stats.size,
      reason,
      timestamp,
      compressed,
    };
  }

  /**
   * Generate archive file path
   */
  private generateArchivePath(timestamp: Date, reason: 'size' | 'time'): string {
    const baseName = basename(this.config.filePath, extname(this.config.filePath));
    const extension = extname(this.config.filePath);

    const dateStr = timestamp.toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    const suffix = reason === 'size' ? 'size' : 'time';

    const archiveDir = this.config.archiveDir || dirname(this.config.filePath);
    return join(archiveDir, `${baseName}_${dateStr}_${suffix}${extension}`);
  }

  /**
   * Compress a file using gzip
   */
  private async compressFile(inputPath: string, outputPath: string): Promise<void> {
    const input = createReadStream(inputPath);
    const output = createWriteStream(outputPath);
    const gzip = createGzip({ level: 6 });

    await pipeline(input, gzip, output);
  }

  /**
   * Clean up old archived files based on retention policy
   */
  private async cleanupOldFiles(): Promise<void> {
    const archiveDir = this.config.archiveDir || dirname(this.config.filePath);

    try {
      const files = await readdir(archiveDir);
      const baseName = basename(this.config.filePath, extname(this.config.filePath));

      // Filter for archived files from this log
      const archiveFiles = files
        .filter((file) => file.startsWith(`${baseName}_`))
        .map((file) => ({
          name: file,
          path: join(archiveDir, file),
        }));

      if (archiveFiles.length === 0) {
        return;
      }

      // Get file stats
      const fileStats = await Promise.all(
        archiveFiles.map(async (file) => {
          const stats = await stat(file.path);
          return {
            ...file,
            mtime: stats.mtime,
            size: stats.size,
          };
        }),
      );

      // Sort by modification time (newest first)
      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      const filesToDelete: string[] = [];
      const now = new Date();

      // Apply retention policies
      for (let i = 0; i < fileStats.length; i++) {
        const file = fileStats[i];
        let shouldDelete = false;

        // Check max files policy
        if (this.config.retention.maxFiles && i >= this.config.retention.maxFiles) {
          shouldDelete = true;
        }

        // Check max age policy
        if (this.config.retention.maxDays) {
          const ageInDays = (now.getTime() - file.mtime.getTime()) / (1000 * 60 * 60 * 24);
          if (ageInDays > this.config.retention.maxDays) {
            shouldDelete = true;
          }
        }

        if (shouldDelete) {
          filesToDelete.push(file.path);
        }
      }

      // Delete old files
      await Promise.all(filesToDelete.map((path) => unlink(path)));

      if (filesToDelete.length > 0) {
        this.cleanupCounter.inc(filesToDelete.length);
      }

      // Update archive files count
      this.archiveFilesGauge.set(fileStats.length - filesToDelete.length);
    } catch (error) {
      // Log cleanup errors but don't fail rotation
      console.error(
        `Failed to cleanup old log files: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Force rotation regardless of triggers
   */
  async forceRotation(reason: 'size' | 'time' = 'size'): Promise<RotationEvent | null> {
    const result = this.rotationLock.then(async () => {
      if (this.rotationInProgress) {
        return null;
      }

      try {
        this.rotationInProgress = true;

        // Check if file exists
        try {
          await stat(this.config.filePath);
        } catch {
          return null; // File doesn't exist
        }

        const startTime = performance.now();
        const event = await this.rotateFile(reason);
        const duration = (performance.now() - startTime) / 1000;

        this.rotationDurationGauge.set(duration);
        this.rotationCounter.inc();

        await this.cleanupOldFiles();

        return event;
      } finally {
        this.rotationInProgress = false;
      }
    });

    this.rotationLock = result;
    return result;
  }

  /**
   * Get current rotation status
   */
  async getStatus(): Promise<{
    needsRotation: boolean;
    reason?: 'size' | 'time';
    currentSize?: number;
    lastRotation?: Date;
    archiveCount: number;
  }> {
    const reason = await this.needsRotation();
    let currentSize: number | undefined;

    try {
      const stats = await stat(this.config.filePath);
      currentSize = stats.size;
    } catch {
      // File doesn't exist
    }

    const archiveDir = this.config.archiveDir || dirname(this.config.filePath);
    let archiveCount = 0;

    try {
      const files = await readdir(archiveDir);
      const baseName = basename(this.config.filePath, extname(this.config.filePath));
      archiveCount = files.filter((file) => file.startsWith(`${baseName}_`)).length;
    } catch {
      // Archive directory doesn't exist or can't be read
    }

    return {
      needsRotation: reason !== null,
      reason: reason || undefined,
      currentSize,
      archiveCount,
    };
  }
}

/**
 * Create a rotation manager with default settings
 */
export function createRotationManager(
  filePath: string,
  options: Partial<RotationConfig> = {},
): LogRotationManager {
  return new LogRotationManager({
    filePath,
    trigger: {
      maxSize: 10 * 1024 * 1024, // 10MB
      interval: 'daily',
      ...options.trigger,
    },
    retention: {
      maxFiles: 30,
      maxDays: 30,
      compress: true,
      ...options.retention,
    },
    archiveDir: options.archiveDir,
  });
}
