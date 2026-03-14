// Main logging interfaces and types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}

export interface LogWriter {
  write(entry: LogEntry): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LogFormatter {
  format(entry: LogEntry): string;
}

export interface LoggerConfig {
  level: LogLevel;
  writers: LogWriter[];
  formatter?: LogFormatter;
}

// Formatters
export { JsonFormatter, TextFormatter } from './formatters.js';

// Writers
export { ConsoleWriter, FileWriter, MultiWriter } from './writers.js';

// Logger implementation
export { StructuredLoggerImpl, type StructuredLogger } from './logger.js';

// Correlation tracking
export { correlation, withCorrelation, withCorrelationAsync } from './correlation.js';

// Hono middleware for HTTP correlation
export {
  correlationMiddleware,
  defaultCorrelationMiddleware,
  correlationWithTimingMiddleware,
  getCurrentCorrelationId,
  addCorrelationMetadata,
  getCorrelationElapsedTime,
  type CorrelationMiddlewareOptions,
} from './middleware.js';

// WebSocket correlation utilities
export {
  withWebSocketCorrelation,
  createCorrelatedWebSocketHandler,
  withWebSocketCorrelationStream,
  getCurrentCorrelationId as getWebSocketCorrelationId,
  addWebSocketCorrelationMetadata,
  getWebSocketCorrelationElapsedTime,
  type WebSocketCorrelationOptions,
} from './websocket.js';

// Factory functions
export {
  createLogger,
  createConsoleLogger,
  createFileLogger,
  createDualLogger,
  createProductionLogger,
  createDevelopmentLogger,
  type LoggerFactoryConfig,
  type LoggerOutputConfig,
} from './factory.js';

// Metrics system
export {
  // Core metrics types and classes
  Counter,
  Gauge,
  Histogram,
  Timer,
  MetricsRegistry,
  defaultRegistry,
  // Convenience functions
  counter,
  gauge,
  histogram,
  timer,
  // Types
  type Metric,
  type MetricLabels,
  type MetricSnapshot,
  type HistogramSnapshot,
  type TimerSnapshot,
  type HistogramBucket,
} from './metrics.js';

// Metrics collectors
export {
  ProcessMetricsCollector,
  HttpMetricsCollector,
  WebSocketMetricsCollector,
  AgentMetricsCollector,
  MetricsCollectionManager,
  createDefaultCollectionManager,
  defaultCollectionManager,
  processMetrics,
  httpMetrics,
  webSocketMetrics,
  agentMetrics,
  type MetricCollector,
} from './collectors.js';

// Metrics reporters
export {
  JsonMetricsReporter,
  PrometheusMetricsReporter,
  PeriodicMetricsReporter,
  MetricsExportManager,
  createDefaultExportManager,
  createJsonReporter,
  createPrometheusReporter,
  createPeriodicReporter,
  defaultExportManager,
  type MetricsReporter,
  type PeriodicReporterConfig,
} from './reporters.js';

// Log rotation system
export {
  LogRotationManager,
  createRotationManager,
  type RotationConfig,
  type RotationTrigger,
  type RetentionPolicy,
  type RotationEvent,
  type RotationInterval,
} from './rotation.js';

// Log aggregation system
export {
  LogAggregator,
  createLogAggregator,
  mergeAggregationResults,
  type LogSource,
  type AggregationOptions,
  type AggregatedLogEntry,
  type AggregationResult,
  type LogStreamEvent,
} from './aggregation.js';

// Enhanced stream writer with rotation
export {
  RotatingStreamWriter,
  createRotatingWriter,
  createHighVolumeWriter,
  type StreamWriterConfig,
} from './stream-writer.js';
