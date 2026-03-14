import { JsonFormatter, TextFormatter } from './formatters.js';
import type { LogLevel, LogWriter } from './index.js';
import { type StructuredLogger, StructuredLoggerImpl } from './logger.js';
import { ConsoleWriter, FileWriter, MultiWriter } from './writers.js';

/**
 * Configuration options for logger factory
 */
export interface LoggerFactoryConfig {
  level: LogLevel;
  component?: string;
  context?: Record<string, unknown>;
  enablePerformanceMetrics?: boolean;
  outputs?: LoggerOutputConfig[];
}

/**
 * Configuration for different output destinations
 */
export interface LoggerOutputConfig {
  type: 'console' | 'file';
  format: 'json' | 'text';
  filePath?: string; // Required for file output
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: LoggerFactoryConfig = {
  level: 'info',
  enablePerformanceMetrics: false,
  outputs: [{ type: 'console', format: 'text' }],
};

/**
 * Create a configured logger instance
 */
export function createLogger(config: Partial<LoggerFactoryConfig> = {}): StructuredLogger {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Ensure outputs is defined
  const outputs = mergedConfig.outputs ||
    DEFAULT_CONFIG.outputs || [{ type: 'console' as const, format: 'text' as const }];

  // Create writers based on configuration
  const writers: LogWriter[] = outputs.map((output) =>
    createWriter(output, mergedConfig.component),
  );

  // If multiple writers, wrap in MultiWriter
  const finalWriter = writers.length === 1 ? writers[0] : new MultiWriter(writers);

  return new StructuredLoggerImpl(
    mergedConfig.level,
    [finalWriter],
    mergedConfig.context || {},
    mergedConfig.enablePerformanceMetrics || false,
  );
}

/**
 * Create a writer based on output configuration
 */
function createWriter(output: LoggerOutputConfig, component?: string): LogWriter {
  // Create formatter
  const formatter =
    output.format === 'json' ? new JsonFormatter(component) : new TextFormatter(component);

  // Create writer
  switch (output.type) {
    case 'console':
      return new ConsoleWriter(formatter);

    case 'file':
      if (!output.filePath) {
        throw new Error('File output requires filePath to be specified');
      }
      return new FileWriter(output.filePath, formatter);

    default:
      throw new Error(`Unknown output type: ${(output as { type: string }).type}`);
  }
}

/**
 * Create a logger with console output only
 */
export function createConsoleLogger(
  level: LogLevel = 'info',
  format: 'json' | 'text' = 'text',
  component?: string,
): StructuredLogger {
  return createLogger({
    level,
    component,
    outputs: [{ type: 'console', format }],
  });
}

/**
 * Create a logger with file output only
 */
export function createFileLogger(
  filePath: string,
  level: LogLevel = 'info',
  format: 'json' | 'text' = 'json',
  component?: string,
): StructuredLogger {
  return createLogger({
    level,
    component,
    outputs: [{ type: 'file', format, filePath }],
  });
}

/**
 * Create a logger with both console and file output
 */
export function createDualLogger(
  filePath: string,
  level: LogLevel = 'info',
  consoleFormat: 'json' | 'text' = 'text',
  fileFormat: 'json' | 'text' = 'json',
  component?: string,
): StructuredLogger {
  return createLogger({
    level,
    component,
    outputs: [
      { type: 'console', format: consoleFormat },
      { type: 'file', format: fileFormat, filePath },
    ],
  });
}

/**
 * Create a production-ready logger with JSON file output and text console output
 */
export function createProductionLogger(
  logFilePath: string,
  component?: string,
  level: LogLevel = 'info',
): StructuredLogger {
  return createDualLogger(
    logFilePath,
    level,
    'text', // Human-readable console output
    'json', // Structured file output
    component,
  );
}

/**
 * Create a development-friendly logger with text console output only
 */
export function createDevelopmentLogger(
  component?: string,
  level: LogLevel = 'debug',
): StructuredLogger {
  return createConsoleLogger(level, 'text', component);
}
