import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLogger } from './logger.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'filelogger-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('FileLogger', () => {
  it('creates log directory if it does not exist', async () => {
    const logDir = join(tempDir, 'nested', 'subdir');
    const logger = await FileLogger.create(logDir, 'test.log');
    logger.info('hello');
    await logger.flush();
    await logger.close();

    const content = await readFile(join(logDir, 'test.log'), 'utf8');
    expect(content).toContain('hello');
  });

  it('writes timestamped lines', async () => {
    const logger = await FileLogger.create(tempDir, 'test.log');
    logger.info('hello world');
    await logger.flush();
    await logger.close();

    const content = await readFile(join(tempDir, 'test.log'), 'utf8');
    const line = content.trim();
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] hello world$/);
  });

  it('writes multiple log levels', async () => {
    const logger = await FileLogger.create(tempDir, 'test.log');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');
    await logger.flush();
    await logger.close();

    const content = await readFile(join(tempDir, 'test.log'), 'utf8');
    expect(content).toMatch(/\[info\] info message/);
    expect(content).toMatch(/\[warn\] warn message/);
    expect(content).toMatch(/\[error\] error message/);
  });

  it('appends to existing log file', async () => {
    const logFile = 'test.log';

    const logger1 = await FileLogger.create(tempDir, logFile);
    logger1.info('first line');
    await logger1.flush();
    await logger1.close();

    const logger2 = await FileLogger.create(tempDir, logFile);
    logger2.info('second line');
    await logger2.flush();
    await logger2.close();

    const content = await readFile(join(tempDir, logFile), 'utf8');
    expect(content).toContain('first line');
    expect(content).toContain('second line');
  });

  it('close() flushes and finalizes the stream', async () => {
    const logger = await FileLogger.create(tempDir, 'test.log');
    logger.info('final message');
    await logger.close();

    const content = await readFile(join(tempDir, 'test.log'), 'utf8');
    expect(content).toContain('final message');
  });
});
