import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { JsonFormatter, TextFormatter } from './formatters.js';
import type { LogEntry, LogFormatter, LogLevel } from './index.js';
import { type Counter, type Gauge, defaultRegistry } from './metrics.js';

/**
 * Log source configuration
 */
export interface LogSource {
  /** Path to the log file or directory */
  path: string;
  /** Pattern to match files (for directories) */
  pattern?: string;
  /** Log format (json or text) */
  format: 'json' | 'text';
  /** Optional label to identify the source */
  label?: string;
}

/**
 * Aggregation options
 */
export interface AggregationOptions {
  /** Start time for log entries (inclusive) */
  startTime?: Date;
  /** End time for log entries (exclusive) */
  endTime?: Date;
  /** Log levels to include */
  levels?: string[];
  /** Search pattern to match against log messages */
  searchPattern?: RegExp;
  /** Maximum number of entries to return */
  limit?: number;
  /** Sort order for results */
  sortOrder?: 'asc' | 'desc';
  /** Whether to include context in results */
  includeContext?: boolean;
}

/**
 * Aggregated log entry with source information
 */
export interface AggregatedLogEntry extends LogEntry {
  /** Source file path */
  source: string;
  /** Source label (if provided) */
  sourceLabel?: string;
  /** Line number in source file */
  lineNumber: number;
}

/**
 * Aggregation result metadata
 */
export interface AggregationResult {
  /** Total number of entries found */
  totalEntries: number;
  /** Number of sources processed */
  sourcesProcessed: number;
  /** Processing time in milliseconds */
  processingTime: number;
  /** Entries that matched the criteria */
  entries: AggregatedLogEntry[];
  /** Any errors encountered during processing */
  errors: Array<{ source: string; error: string }>;
}

/**
 * Log entry stream event
 */
export interface LogStreamEvent {
  type: 'entry' | 'error' | 'complete';
  entry?: AggregatedLogEntry;
  error?: { source: string; error: string };
  metadata?: { totalEntries: number; sourcesProcessed: number };
}

/**
 * Log aggregation system
 */
export class LogAggregator {
  private sources: LogSource[] = [];

  // Metrics
  private aggregationCounter: Counter;
  private entriesProcessedCounter: Counter;
  private processingTimeGauge: Gauge;
  private sourcesProcessedGauge: Gauge;
  private errorsCounter: Counter;

  constructor(sources: LogSource[] = []) {
    this.sources = sources;

    // Initialize metrics
    this.aggregationCounter = defaultRegistry.getOrCreateCounter(
      'log_aggregations_total',
      'Total number of log aggregations performed',
    );
    this.entriesProcessedCounter = defaultRegistry.getOrCreateCounter(
      'log_entries_processed_total',
      'Total number of log entries processed during aggregation',
    );
    this.processingTimeGauge = defaultRegistry.getOrCreateGauge(
      'log_aggregation_duration_seconds',
      'Duration of the last log aggregation in seconds',
    );
    this.sourcesProcessedGauge = defaultRegistry.getOrCreateGauge(
      'log_sources_processed_count',
      'Number of log sources processed in the last aggregation',
    );
    this.errorsCounter = defaultRegistry.getOrCreateCounter(
      'log_aggregation_errors_total',
      'Total number of errors during log aggregation',
    );
  }

  /**
   * Add a log source
   */
  addSource(source: LogSource): void {
    this.sources.push(source);
  }

  /**
   * Remove a log source
   */
  removeSource(path: string): void {
    this.sources = this.sources.filter((source) => source.path !== path);
  }

  /**
   * Get all configured sources
   */
  getSources(): LogSource[] {
    return [...this.sources];
  }

  /**
   * Aggregate logs from all sources
   */
  async aggregate(options: AggregationOptions = {}): Promise<AggregationResult> {
    const startTime = Date.now();

    try {
      this.aggregationCounter.inc();

      const allEntries: AggregatedLogEntry[] = [];
      const errors: Array<{ source: string; error: string }> = [];
      let sourcesProcessed = 0;

      // Process each source
      for (const source of this.sources) {
        try {
          const files = await this.getSourceFiles(source);

          for (const filePath of files) {
            const entries = await this.processFile(filePath, source, options);
            allEntries.push(...entries);
          }

          sourcesProcessed++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          errors.push({ source: source.path, error: errorMsg });
          this.errorsCounter.inc();
        }
      }

      // Filter and sort entries
      let filteredEntries = this.filterEntries(allEntries, options);
      filteredEntries = this.sortEntries(filteredEntries, options.sortOrder || 'asc');

      // Apply limit
      if (options.limit && options.limit > 0) {
        filteredEntries = filteredEntries.slice(0, options.limit);
      }

      const processingTime = Date.now() - startTime;

      // Update metrics
      this.entriesProcessedCounter.inc(allEntries.length);
      this.processingTimeGauge.set(processingTime / 1000);
      this.sourcesProcessedGauge.set(sourcesProcessed);

      return {
        totalEntries: filteredEntries.length,
        sourcesProcessed,
        processingTime,
        entries: filteredEntries,
        errors,
      };
    } catch (error) {
      this.errorsCounter.inc();
      throw new Error(
        `Aggregation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Stream logs from all sources
   */
  async *stream(options: AggregationOptions = {}): AsyncGenerator<LogStreamEvent, void, unknown> {
    const startTime = Date.now();
    let totalEntries = 0;
    let sourcesProcessed = 0;

    try {
      this.aggregationCounter.inc();

      // Process each source
      for (const source of this.sources) {
        try {
          const files = await this.getSourceFiles(source);

          for (const filePath of files) {
            const entries = await this.processFile(filePath, source, options);

            // Filter entries
            const filteredEntries = this.filterEntries(entries, options);

            for (const entry of filteredEntries) {
              totalEntries++;
              yield { type: 'entry', entry };

              // Check limit
              if (options.limit && totalEntries >= options.limit) {
                break;
              }
            }

            if (options.limit && totalEntries >= options.limit) {
              break;
            }
          }

          sourcesProcessed++;

          if (options.limit && totalEntries >= options.limit) {
            break;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          yield {
            type: 'error',
            error: { source: source.path, error: errorMsg },
          };
          this.errorsCounter.inc();
        }
      }

      // Update metrics
      this.entriesProcessedCounter.inc(totalEntries);
      this.processingTimeGauge.set((Date.now() - startTime) / 1000);
      this.sourcesProcessedGauge.set(sourcesProcessed);

      // Emit completion event
      yield {
        type: 'complete',
        metadata: { totalEntries, sourcesProcessed },
      };
    } catch (error) {
      this.errorsCounter.inc();
      yield {
        type: 'error',
        error: {
          source: 'aggregator',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Search logs with specific criteria
   */
  async search(
    pattern: RegExp | string,
    options: Omit<AggregationOptions, 'searchPattern'> = {},
  ): Promise<AggregationResult> {
    const searchPattern = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;

    return this.aggregate({
      ...options,
      searchPattern,
    });
  }

  /**
   * Get log entries within a time range
   */
  async getRange(
    startTime: Date,
    endTime: Date,
    options: Omit<AggregationOptions, 'startTime' | 'endTime'> = {},
  ): Promise<AggregationResult> {
    return this.aggregate({
      ...options,
      startTime,
      endTime,
    });
  }

  /**
   * Get log entries by level
   */
  async getByLevel(
    levels: string[],
    options: Omit<AggregationOptions, 'levels'> = {},
  ): Promise<AggregationResult> {
    return this.aggregate({
      ...options,
      levels,
    });
  }

  /**
   * Get files for a source
   */
  private async getSourceFiles(source: LogSource): Promise<string[]> {
    try {
      const stats = await stat(source.path);

      if (stats.isFile()) {
        return [source.path];
      }

      if (stats.isDirectory()) {
        const files = await readdir(source.path);
        const pattern = source.pattern ? new RegExp(source.pattern) : /\.log$/;

        return files.filter((file) => pattern.test(file)).map((file) => join(source.path, file));
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Process a single log file
   */
  private async processFile(
    filePath: string,
    source: LogSource,
    options: AggregationOptions,
  ): Promise<AggregatedLogEntry[]> {
    const entries: AggregatedLogEntry[] = [];
    const isCompressed = filePath.endsWith('.gz');

    let inputStream: NodeJS.ReadableStream;

    if (isCompressed) {
      const fileStream = createReadStream(filePath);
      const gunzipStream = createGunzip();
      fileStream.pipe(gunzipStream);
      inputStream = gunzipStream;
    } else {
      inputStream = createReadStream(filePath);
    }

    const readline = createInterface({
      input: inputStream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let lineNumber = 0;

    for await (const line of readline) {
      lineNumber++;

      if (line.trim() === '') {
        continue;
      }

      try {
        const entry = this.parseLine(line, source.format);
        if (entry) {
          const aggregatedEntry: AggregatedLogEntry = {
            ...entry,
            source: filePath,
            sourceLabel: source.label,
            lineNumber,
          };

          entries.push(aggregatedEntry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Parse a log line based on format
   */
  private parseLine(line: string, format: 'json' | 'text'): LogEntry | null {
    try {
      if (format === 'json') {
        const parsed = JSON.parse(line);

        // Ensure required fields are present
        if (!parsed.timestamp || !parsed.level || !parsed.message) {
          return null;
        }

        return {
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: parsed.message,
          context: parsed.context,
          error: parsed.error,
        };
      }

      if (format === 'text') {
        // Parse text format: timestamp [LEVEL] message
        const match = line.match(/^(\S+)\s+\[(\w+)\]\s+(.+)$/);
        if (!match) {
          return null;
        }

        const level = match[2].toLowerCase();
        if (!['debug', 'info', 'warn', 'error'].includes(level)) {
          return null;
        }

        return {
          timestamp: match[1],
          level: level as LogLevel,
          message: match[3],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Filter entries based on options
   */
  private filterEntries(
    entries: AggregatedLogEntry[],
    options: AggregationOptions,
  ): AggregatedLogEntry[] {
    return entries.filter((entry) => {
      // Time range filter
      if (options.startTime || options.endTime) {
        const entryTime = new Date(entry.timestamp);

        if (options.startTime && entryTime < options.startTime) {
          return false;
        }

        if (options.endTime && entryTime >= options.endTime) {
          return false;
        }
      }

      // Level filter
      if (options.levels && options.levels.length > 0) {
        if (!options.levels.includes(entry.level)) {
          return false;
        }
      }

      // Search pattern filter
      if (options.searchPattern) {
        const searchText = [
          entry.message,
          entry.context ? JSON.stringify(entry.context) : '',
          entry.error?.message || '',
        ].join(' ');

        if (!options.searchPattern.test(searchText)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Sort entries by timestamp
   */
  private sortEntries(entries: AggregatedLogEntry[], order: 'asc' | 'desc'): AggregatedLogEntry[] {
    return entries.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();

      return order === 'asc' ? timeA - timeB : timeB - timeA;
    });
  }
}

/**
 * Create a log aggregator with sources
 */
export function createLogAggregator(sources: LogSource[]): LogAggregator {
  return new LogAggregator(sources);
}

/**
 * Merge multiple aggregation results
 */
export function mergeAggregationResults(results: AggregationResult[]): AggregationResult {
  if (results.length === 0) {
    return {
      totalEntries: 0,
      sourcesProcessed: 0,
      processingTime: 0,
      entries: [],
      errors: [],
    };
  }

  if (results.length === 1) {
    return results[0];
  }

  const allEntries = results.flatMap((result) => result.entries);
  const allErrors = results.flatMap((result) => result.errors);

  // Sort merged entries by timestamp
  allEntries.sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  return {
    totalEntries: allEntries.length,
    sourcesProcessed: results.reduce((sum, result) => sum + result.sourcesProcessed, 0),
    processingTime: Math.max(...results.map((result) => result.processingTime)),
    entries: allEntries,
    errors: allErrors,
  };
}
