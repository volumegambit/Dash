import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class FileLogger implements Logger {
  private stream: WriteStream;

  private constructor(stream: WriteStream) {
    this.stream = stream;
  }

  static async create(logDir: string, filename: string): Promise<FileLogger> {
    await mkdir(logDir, { recursive: true });
    const filePath = join(logDir, filename);
    const stream = createWriteStream(filePath, { flags: 'a' });
    return new FileLogger(stream);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    let line: string;
    if (context !== undefined) {
      line = JSON.stringify({ ts: timestamp, level, msg: message, ...context }) + '\n';
    } else {
      line = `${timestamp} [${level}] ${message}\n`;
    }
    this.stream.write(line);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  flush(): Promise<void> {
    if (!this.stream.writableNeedDrain) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.stream.once('drain', resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.on('error', reject);
      this.stream.end(() => resolve());
    });
  }
}
