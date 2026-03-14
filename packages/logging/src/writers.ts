import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LogEntry, LogFormatter, LogWriter } from './index.js';

/**
 * Console writer that outputs to stdout/stderr using appropriate console methods
 */
export class ConsoleWriter implements LogWriter {
  private formatter: LogFormatter;

  constructor(formatter: LogFormatter) {
    this.formatter = formatter;
  }

  async write(entry: LogEntry): Promise<void> {
    const formatted = this.formatter.format(entry);

    switch (entry.level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
      default:
        console.log(formatted);
    }
  }

  async flush(): Promise<void> {
    // Console output is immediately flushed by Node.js
  }

  async close(): Promise<void> {
    // Nothing to close for console output
  }
}

/**
 * File writer that handles file creation and appending safely
 */
export class FileWriter implements LogWriter {
  private formatter: LogFormatter;
  private filePath: string;
  private isInitialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, formatter: LogFormatter) {
    this.filePath = filePath;
    this.formatter = formatter;
  }

  private async ensureDirectoryExists(): Promise<void> {
    if (this.isInitialized) return;

    try {
      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      this.isInitialized = true;
    } catch (error) {
      throw new Error(
        `Failed to create log directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async write(entry: LogEntry): Promise<void> {
    const formatted = `${this.formatter.format(entry)}\n`;

    // Queue writes to prevent race conditions
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureDirectoryExists();

      try {
        await appendFile(this.filePath, formatted, 'utf8');
      } catch (error) {
        throw new Error(
          `Failed to write to log file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    });

    await this.writeQueue;
  }

  async flush(): Promise<void> {
    // Wait for any pending writes to complete
    await this.writeQueue;
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

/**
 * Multi-writer that writes to multiple writers simultaneously
 */
export class MultiWriter implements LogWriter {
  private writers: LogWriter[];

  constructor(writers: LogWriter[]) {
    if (writers.length === 0) {
      throw new Error('MultiWriter requires at least one writer');
    }
    this.writers = writers;
  }

  async write(entry: LogEntry): Promise<void> {
    // Write to all writers in parallel
    const writePromises = this.writers.map((writer) => {
      return writer.write(entry).catch((error) => {
        // Log writer errors to console to avoid losing them completely
        console.error(
          `Log writer error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      });
    });

    await Promise.all(writePromises);
  }

  async flush(): Promise<void> {
    const flushPromises = this.writers.map((writer) => {
      return writer.flush().catch((error) => {
        console.error(
          `Log writer flush error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      });
    });

    await Promise.all(flushPromises);
  }

  async close(): Promise<void> {
    const closePromises = this.writers.map((writer) => {
      return writer.close().catch((error) => {
        console.error(
          `Log writer close error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      });
    });

    await Promise.all(closePromises);
  }
}
