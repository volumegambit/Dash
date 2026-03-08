import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
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

  private write(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} [${level}] ${message}\n`;
    this.stream.write(line);
  }

  info(message: string): void {
    this.write('info', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  error(message: string): void {
    this.write('error', message);
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
