import { EventEmitter } from 'node:events';
import { correlation } from './correlation.js';
import type { LogWriter, StructuredLogger } from './index.js';
import {
  type HistogramSnapshot,
  type MetricLabels,
  type MetricSnapshot,
  type MetricsRegistry,
  type TimerSnapshot,
  defaultRegistry,
} from './metrics.js';

/**
 * Base interface for metrics reporters
 */
export interface MetricsReporter {
  readonly name: string;
  export(): Promise<string>;
  start?(): void;
  stop?(): void;
}

/**
 * Configuration for periodic reporting
 */
export interface PeriodicReporterConfig {
  intervalMs: number;
  logger?: StructuredLogger;
  writer?: LogWriter;
  includeTimestamp?: boolean;
}

/**
 * JSON metrics reporter
 */
export class JsonMetricsReporter implements MetricsReporter {
  public readonly name = 'json';

  constructor(
    private readonly registry: MetricsRegistry = defaultRegistry,
    private readonly config: {
      includeMetadata?: boolean;
      prettyPrint?: boolean;
      includeEmpty?: boolean;
    } = {},
  ) {}

  async export(): Promise<string> {
    const snapshots = this.registry.getAllSnapshots();
    const timestamp = Date.now();
    const correlationId = correlation.getId();

    const data: Record<string, unknown> = {
      timestamp,
      metrics: this.config.includeEmpty ? snapshots : snapshots.filter((m) => this.hasValue(m)),
    };

    if (this.config.includeMetadata) {
      data.metadata = {
        correlationId,
        exportedAt: new Date(timestamp).toISOString(),
        registry: 'default',
        metricsCount: snapshots.length,
      };
    }

    if (this.config.prettyPrint) {
      return JSON.stringify(data, null, 2);
    }

    return JSON.stringify(data);
  }

  private hasValue(snapshot: MetricSnapshot): boolean {
    if (typeof snapshot.value === 'number') {
      return snapshot.value !== 0;
    }

    if (this.isHistogramSnapshot(snapshot.value)) {
      return snapshot.value.count > 0;
    }

    if (this.isTimerSnapshot(snapshot.value)) {
      return snapshot.value.count > 0;
    }

    return true;
  }

  private isHistogramSnapshot(value: unknown): value is HistogramSnapshot {
    return typeof value === 'object' && value !== null && 'buckets' in value;
  }

  private isTimerSnapshot(value: unknown): value is TimerSnapshot {
    return typeof value === 'object' && value !== null && 'mean' in value;
  }
}

/**
 * Prometheus text format reporter
 */
export class PrometheusMetricsReporter implements MetricsReporter {
  public readonly name = 'prometheus';

  constructor(private readonly registry: MetricsRegistry = defaultRegistry) {}

  async export(): Promise<string> {
    const snapshots = this.registry.getAllSnapshots();
    const lines: string[] = [];

    for (const snapshot of snapshots) {
      lines.push(...this.formatMetric(snapshot));
    }

    return `${lines.join('\n')}\n`;
  }

  private formatMetric(snapshot: MetricSnapshot): string[] {
    const lines: string[] = [];
    const { name, help, type, value, labels } = snapshot;

    // Add help comment
    lines.push(`# HELP ${name} ${help}`);

    // Add type comment
    let promType = type;
    if (type === 'timer') {
      promType = 'histogram'; // Timers are represented as histograms in Prometheus
    }
    lines.push(`# TYPE ${name} ${promType}`);

    // Format metric based on type
    if (typeof value === 'number') {
      // Counter or Gauge
      lines.push(`${name}${this.formatLabels(labels)} ${value}`);
    } else if (this.isHistogramSnapshot(value)) {
      // Histogram
      lines.push(...this.formatHistogram(name, labels, value));
    } else if (this.isTimerSnapshot(value)) {
      // Timer (as histogram)
      lines.push(...this.formatTimer(name, labels, value));
    }

    return lines;
  }

  private formatHistogram(name: string, labels: MetricLabels, value: HistogramSnapshot): string[] {
    const lines: string[] = [];
    const baseLabels = this.formatLabels(labels);

    // Bucket metrics
    for (const bucket of value.buckets) {
      const bucketLabels = this.formatLabels({
        ...labels,
        le: bucket.upperBound === Number.POSITIVE_INFINITY ? '+Inf' : bucket.upperBound.toString(),
      });
      lines.push(`${name}_bucket${bucketLabels} ${bucket.count}`);
    }

    // Count and sum
    lines.push(`${name}_count${baseLabels} ${value.count}`);
    lines.push(`${name}_sum${baseLabels} ${value.sum}`);

    return lines;
  }

  private formatTimer(name: string, labels: MetricLabels, value: TimerSnapshot): string[] {
    const lines: string[] = [];
    const baseLabels = this.formatLabels(labels);

    // Convert timer to histogram-like format
    const buckets = [
      { le: '0.001', count: this.countBelow(value, 1) },
      { le: '0.005', count: this.countBelow(value, 5) },
      { le: '0.01', count: this.countBelow(value, 10) },
      { le: '0.025', count: this.countBelow(value, 25) },
      { le: '0.05', count: this.countBelow(value, 50) },
      { le: '0.1', count: this.countBelow(value, 100) },
      { le: '0.25', count: this.countBelow(value, 250) },
      { le: '0.5', count: this.countBelow(value, 500) },
      { le: '1', count: this.countBelow(value, 1000) },
      { le: '2.5', count: this.countBelow(value, 2500) },
      { le: '5', count: this.countBelow(value, 5000) },
      { le: '10', count: this.countBelow(value, 10000) },
      { le: '+Inf', count: value.count },
    ];

    for (const bucket of buckets) {
      const bucketLabels = this.formatLabels({ ...labels, le: bucket.le });
      lines.push(`${name}_bucket${bucketLabels} ${bucket.count}`);
    }

    lines.push(`${name}_count${baseLabels} ${value.count}`);
    lines.push(`${name}_sum${baseLabels} ${value.sum}`);

    return lines;
  }

  private countBelow(timer: TimerSnapshot, thresholdMs: number): number {
    // This is an approximation since we don't have access to raw values
    // In practice, you might want to store histogram buckets in Timer as well
    if (timer.p99 <= thresholdMs) return timer.count;
    if (timer.p95 <= thresholdMs) return Math.floor(timer.count * 0.95);
    if (timer.p90 <= thresholdMs) return Math.floor(timer.count * 0.9);
    if (timer.p50 <= thresholdMs) return Math.floor(timer.count * 0.5);
    if (timer.min <= thresholdMs) return Math.floor(timer.count * 0.25);
    return 0;
  }

  private formatLabels(labels: MetricLabels): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) {
      return '';
    }

    const labelPairs = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}="${this.escapeValue(value.toString())}"`)
      .join(',');

    return `{${labelPairs}}`;
  }

  private escapeValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  private isHistogramSnapshot(value: unknown): value is HistogramSnapshot {
    return typeof value === 'object' && value !== null && 'buckets' in value;
  }

  private isTimerSnapshot(value: unknown): value is TimerSnapshot {
    return typeof value === 'object' && value !== null && 'mean' in value;
  }
}

/**
 * Periodic metrics reporter that exports metrics at regular intervals
 */
export class PeriodicMetricsReporter extends EventEmitter {
  private interval?: NodeJS.Timeout;
  private isStarted = false;

  constructor(
    private readonly reporter: MetricsReporter,
    private readonly config: PeriodicReporterConfig,
  ) {
    super();
  }

  /**
   * Start periodic reporting
   */
  start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;

    if (this.reporter.start) {
      this.reporter.start();
    }

    this.interval = setInterval(async () => {
      try {
        await this.report();
      } catch (error) {
        this.emit('error', error);
      }
    }, this.config.intervalMs);

    this.emit('started');
  }

  /**
   * Stop periodic reporting
   */
  stop(): void {
    if (!this.isStarted) {
      return;
    }

    this.isStarted = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    if (this.reporter.stop) {
      this.reporter.stop();
    }

    this.emit('stopped');
  }

  /**
   * Trigger a single report
   */
  async report(): Promise<void> {
    const startTime = Date.now();

    try {
      const output = await this.reporter.export();
      const duration = Date.now() - startTime;

      // Log to structured logger if configured
      if (this.config.logger) {
        this.config.logger.info('Metrics exported', {
          reporter: this.reporter.name,
          duration,
          size: output.length,
          timestamp: this.config.includeTimestamp ? Date.now() : undefined,
        });
      }

      // Write to log writer if configured
      if (this.config.writer) {
        await this.config.writer.write({
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Metrics Report',
          context: {
            reporter: this.reporter.name,
            data: this.config.includeTimestamp ? output : undefined,
          },
        });
      }

      this.emit('report', output, duration);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Check if reporter is running
   */
  get running(): boolean {
    return this.isStarted;
  }

  /**
   * Get reporter name
   */
  get name(): string {
    return this.reporter.name;
  }
}

/**
 * Metrics export manager for handling multiple reporters
 */
export class MetricsExportManager extends EventEmitter {
  private reporters = new Map<string, MetricsReporter>();
  private periodicReporters = new Map<string, PeriodicMetricsReporter>();

  /**
   * Register a metrics reporter
   */
  register(reporter: MetricsReporter): void {
    if (this.reporters.has(reporter.name)) {
      throw new Error(`Reporter already registered: ${reporter.name}`);
    }

    this.reporters.set(reporter.name, reporter);
    this.emit('reporter:registered', reporter.name);
  }

  /**
   * Unregister a metrics reporter
   */
  unregister(name: string): boolean {
    const reporter = this.reporters.get(name);
    if (reporter) {
      // Stop periodic reporter if exists
      const periodicReporter = this.periodicReporters.get(name);
      if (periodicReporter) {
        periodicReporter.stop();
        this.periodicReporters.delete(name);
      }

      this.reporters.delete(name);
      this.emit('reporter:unregistered', name);
      return true;
    }
    return false;
  }

  /**
   * Get a registered reporter
   */
  get<T extends MetricsReporter>(name: string): T | undefined {
    return this.reporters.get(name) as T | undefined;
  }

  /**
   * Export metrics from a specific reporter
   */
  async export(reporterName: string): Promise<string> {
    const reporter = this.reporters.get(reporterName);
    if (!reporter) {
      throw new Error(`Reporter not found: ${reporterName}`);
    }

    return reporter.export();
  }

  /**
   * Export metrics from all reporters
   */
  async exportAll(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    for (const [name, reporter] of this.reporters) {
      try {
        results[name] = await reporter.export();
      } catch (error) {
        this.emit('export:error', name, error);
        throw error;
      }
    }

    return results;
  }

  /**
   * Start periodic reporting for a reporter
   */
  startPeriodic(reporterName: string, config: PeriodicReporterConfig): void {
    const reporter = this.reporters.get(reporterName);
    if (!reporter) {
      throw new Error(`Reporter not found: ${reporterName}`);
    }

    if (this.periodicReporters.has(reporterName)) {
      throw new Error(`Periodic reporter already started: ${reporterName}`);
    }

    const periodicReporter = new PeriodicMetricsReporter(reporter, config);

    periodicReporter.on('error', (error) => {
      this.emit('periodic:error', reporterName, error);
    });

    periodicReporter.on('report', (output, duration) => {
      this.emit('periodic:report', reporterName, output, duration);
    });

    this.periodicReporters.set(reporterName, periodicReporter);
    periodicReporter.start();
  }

  /**
   * Stop periodic reporting for a reporter
   */
  stopPeriodic(reporterName: string): boolean {
    const periodicReporter = this.periodicReporters.get(reporterName);
    if (periodicReporter) {
      periodicReporter.stop();
      this.periodicReporters.delete(reporterName);
      return true;
    }
    return false;
  }

  /**
   * Stop all periodic reporters
   */
  stopAllPeriodic(): void {
    for (const [name, periodicReporter] of this.periodicReporters) {
      periodicReporter.stop();
      this.emit('periodic:stopped', name);
    }
    this.periodicReporters.clear();
  }

  /**
   * Get all registered reporters
   */
  getAll(): MetricsReporter[] {
    return Array.from(this.reporters.values());
  }

  /**
   * Get status of all periodic reporters
   */
  getPeriodicStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [name, periodicReporter] of this.periodicReporters) {
      status[name] = periodicReporter.running;
    }
    return status;
  }
}

/**
 * Default export manager with standard reporters
 */
export function createDefaultExportManager(): MetricsExportManager {
  const manager = new MetricsExportManager();

  // Register standard reporters
  manager.register(new JsonMetricsReporter());
  manager.register(new PrometheusMetricsReporter());

  return manager;
}

/**
 * Convenience functions for common reporting scenarios
 */
export function createJsonReporter(
  registry?: MetricsRegistry,
  config?: {
    includeMetadata?: boolean;
    prettyPrint?: boolean;
    includeEmpty?: boolean;
  },
): JsonMetricsReporter {
  return new JsonMetricsReporter(registry, config);
}

export function createPrometheusReporter(registry?: MetricsRegistry): PrometheusMetricsReporter {
  return new PrometheusMetricsReporter(registry);
}

export function createPeriodicReporter(
  reporter: MetricsReporter,
  config: PeriodicReporterConfig,
): PeriodicMetricsReporter {
  return new PeriodicMetricsReporter(reporter, config);
}

/**
 * Export singleton instance for convenience
 */
export const defaultExportManager = createDefaultExportManager();
