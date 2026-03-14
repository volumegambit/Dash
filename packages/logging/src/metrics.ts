import { performance } from 'node:perf_hooks';

/**
 * Labels for tagging metrics with metadata
 */
export type MetricLabels = Record<string, string | number>;

/**
 * Base interface for all metrics
 */
export interface Metric {
  readonly name: string;
  readonly help: string;
  readonly labels: MetricLabels;
  readonly type: 'counter' | 'gauge' | 'histogram' | 'timer';
  getValue(): number | HistogramSnapshot | TimerSnapshot;
  getSnapshot(): MetricSnapshot;
  reset(): void;
}

/**
 * Snapshot of metric data for export
 */
export interface MetricSnapshot {
  name: string;
  type: string;
  help: string;
  labels: MetricLabels;
  value: number | HistogramSnapshot | TimerSnapshot;
  timestamp: number;
}

/**
 * Histogram bucket data
 */
export interface HistogramBucket {
  upperBound: number;
  count: number;
}

/**
 * Histogram snapshot data
 */
export interface HistogramSnapshot {
  count: number;
  sum: number;
  buckets: HistogramBucket[];
  quantiles?: Record<string, number>;
}

/**
 * Timer snapshot data
 */
export interface TimerSnapshot {
  count: number;
  sum: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

/**
 * Counter metric - monotonically increasing value
 */
export class Counter implements Metric {
  public readonly type = 'counter';
  private value = 0;

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: MetricLabels = {},
  ) {}

  /**
   * Increment the counter by a positive amount
   */
  inc(amount = 1): void {
    if (amount < 0) {
      throw new Error('Counter increment must be non-negative');
    }
    this.value += amount;
  }

  /**
   * Get current counter value
   */
  getValue(): number {
    return this.value;
  }

  /**
   * Reset counter to zero
   */
  reset(): void {
    this.value = 0;
  }

  /**
   * Get metric snapshot
   */
  getSnapshot(): MetricSnapshot {
    return {
      name: this.name,
      type: this.type,
      help: this.help,
      labels: this.labels,
      value: this.value,
      timestamp: Date.now(),
    };
  }
}

/**
 * Gauge metric - current value that can go up or down
 */
export class Gauge implements Metric {
  public readonly type = 'gauge';
  private value = 0;

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: MetricLabels = {},
  ) {}

  /**
   * Set gauge to a specific value
   */
  set(value: number): void {
    this.value = value;
  }

  /**
   * Increment gauge by amount
   */
  inc(amount = 1): void {
    this.value += amount;
  }

  /**
   * Decrement gauge by amount
   */
  dec(amount = 1): void {
    this.value -= amount;
  }

  /**
   * Get current gauge value
   */
  getValue(): number {
    return this.value;
  }

  /**
   * Reset gauge to zero
   */
  reset(): void {
    this.value = 0;
  }

  /**
   * Get metric snapshot
   */
  getSnapshot(): MetricSnapshot {
    return {
      name: this.name,
      type: this.type,
      help: this.help,
      labels: this.labels,
      value: this.value,
      timestamp: Date.now(),
    };
  }
}

/**
 * Histogram metric - tracks distribution of values
 */
export class Histogram implements Metric {
  public readonly type = 'histogram';
  private buckets: Map<number, number> = new Map();
  private count = 0;
  private sum = 0;
  private values: number[] = [];

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: MetricLabels = {},
    private readonly bucketBounds: number[] = [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ],
  ) {
    // Initialize buckets
    for (const bound of this.bucketBounds) {
      this.buckets.set(bound, 0);
    }
    this.buckets.set(Number.POSITIVE_INFINITY, 0);
  }

  /**
   * Observe a value
   */
  observe(value: number): void {
    this.count++;
    this.sum += value;
    this.values.push(value);

    // Update buckets
    for (const bound of this.bucketBounds) {
      if (value <= bound) {
        const currentCount = this.buckets.get(bound) || 0;
        this.buckets.set(bound, currentCount + 1);
      }
    }

    // Always update infinity bucket
    const infCount = this.buckets.get(Number.POSITIVE_INFINITY) || 0;
    this.buckets.set(Number.POSITIVE_INFINITY, infCount + 1);
  }

  /**
   * Get histogram snapshot
   */
  getValue(): HistogramSnapshot {
    const buckets: HistogramBucket[] = [];
    for (const [upperBound, count] of this.buckets) {
      buckets.push({ upperBound, count });
    }

    // Calculate quantiles
    const sortedValues = this.values.slice().sort((a, b) => a - b);
    const quantiles: Record<string, number> = {};

    if (sortedValues.length > 0) {
      quantiles['0.5'] = this.getQuantile(sortedValues, 0.5);
      quantiles['0.90'] = this.getQuantile(sortedValues, 0.9);
      quantiles['0.95'] = this.getQuantile(sortedValues, 0.95);
      quantiles['0.99'] = this.getQuantile(sortedValues, 0.99);
    }

    return {
      count: this.count,
      sum: this.sum,
      buckets,
      quantiles,
    };
  }

  /**
   * Reset histogram
   */
  reset(): void {
    this.count = 0;
    this.sum = 0;
    this.values = [];
    for (const bound of this.buckets.keys()) {
      this.buckets.set(bound, 0);
    }
  }

  /**
   * Get metric snapshot
   */
  getSnapshot(): MetricSnapshot {
    return {
      name: this.name,
      type: this.type,
      help: this.help,
      labels: this.labels,
      value: this.getValue(),
      timestamp: Date.now(),
    };
  }

  private getQuantile(sortedValues: number[], quantile: number): number {
    if (sortedValues.length === 0) return 0;

    const index = Math.floor(sortedValues.length * quantile);
    const clampedIndex = Math.min(index, sortedValues.length - 1);
    return sortedValues[clampedIndex];
  }
}

/**
 * Timer metric - specialized for measuring durations
 */
export class Timer implements Metric {
  public readonly type = 'timer';
  private measurements: number[] = [];

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: MetricLabels = {},
  ) {}

  /**
   * Time a function execution
   */
  time<T>(fn: () => T): T {
    const start = performance.now();
    try {
      const result = fn();
      return result;
    } finally {
      const duration = performance.now() - start;
      this.record(duration);
    }
  }

  /**
   * Time an async function execution
   */
  async timeAsync<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      return result;
    } finally {
      const duration = performance.now() - start;
      this.record(duration);
    }
  }

  /**
   * Record a timing measurement in milliseconds
   */
  record(duration: number): void {
    this.measurements.push(duration);
  }

  /**
   * Start a timer and return a function to stop it
   */
  startTimer(): () => void {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.record(duration);
    };
  }

  /**
   * Get timer statistics
   */
  getValue(): TimerSnapshot {
    if (this.measurements.length === 0) {
      return {
        count: 0,
        sum: 0,
        mean: 0,
        min: 0,
        max: 0,
        p50: 0,
        p90: 0,
        p95: 0,
        p99: 0,
      };
    }

    const sorted = this.measurements.slice().sort((a, b) => a - b);
    const sum = this.measurements.reduce((a, b) => a + b, 0);

    return {
      count: this.measurements.length,
      sum,
      mean: sum / this.measurements.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: this.getQuantile(sorted, 0.5),
      p90: this.getQuantile(sorted, 0.9),
      p95: this.getQuantile(sorted, 0.95),
      p99: this.getQuantile(sorted, 0.99),
    };
  }

  /**
   * Reset timer measurements
   */
  reset(): void {
    this.measurements = [];
  }

  /**
   * Get metric snapshot
   */
  getSnapshot(): MetricSnapshot {
    return {
      name: this.name,
      type: this.type,
      help: this.help,
      labels: this.labels,
      value: this.getValue(),
      timestamp: Date.now(),
    };
  }

  private getQuantile(sortedValues: number[], quantile: number): number {
    const index = Math.floor(sortedValues.length * quantile);
    const clampedIndex = Math.min(index, sortedValues.length - 1);
    return sortedValues[clampedIndex];
  }
}

/**
 * Registry for managing all metrics
 */
export class MetricsRegistry {
  private metrics = new Map<string, Metric>();
  private readonly mutex = new Set<string>();

  /**
   * Register a metric
   */
  register(metric: Metric): void {
    const key = this.getMetricKey(metric.name, metric.labels);

    if (this.metrics.has(key)) {
      throw new Error(`Metric already registered: ${key}`);
    }

    this.metrics.set(key, metric);
  }

  /**
   * Get a registered metric
   */
  get<T extends Metric>(name: string, labels: MetricLabels = {}): T | undefined {
    const key = this.getMetricKey(name, labels);
    return this.metrics.get(key) as T | undefined;
  }

  /**
   * Get or create a counter
   */
  getOrCreateCounter(name: string, help: string, labels: MetricLabels = {}): Counter {
    const key = this.getMetricKey(name, labels);
    let metric = this.metrics.get(key) as Counter;

    if (!metric) {
      metric = new Counter(name, help, labels);
      this.register(metric);
    }

    return metric;
  }

  /**
   * Get or create a gauge
   */
  getOrCreateGauge(name: string, help: string, labels: MetricLabels = {}): Gauge {
    const key = this.getMetricKey(name, labels);
    let metric = this.metrics.get(key) as Gauge;

    if (!metric) {
      metric = new Gauge(name, help, labels);
      this.register(metric);
    }

    return metric;
  }

  /**
   * Get or create a histogram
   */
  getOrCreateHistogram(
    name: string,
    help: string,
    labels: MetricLabels = {},
    buckets?: number[],
  ): Histogram {
    const key = this.getMetricKey(name, labels);
    const existing = this.metrics.get(key);

    if (existing && existing.type === 'histogram') {
      return existing as Histogram;
    }

    const metric = new Histogram(name, help, labels, buckets);
    this.register(metric);
    return metric;
  }

  /**
   * Get or create a timer
   */
  getOrCreateTimer(name: string, help: string, labels: MetricLabels = {}): Timer {
    const key = this.getMetricKey(name, labels);
    const existing = this.metrics.get(key);

    if (existing && existing.type === 'timer') {
      return existing as Timer;
    }

    const metric = new Timer(name, help, labels);
    this.register(metric);
    return metric;
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Metric[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Get all metric snapshots
   */
  getAllSnapshots(): MetricSnapshot[] {
    return this.getAllMetrics().map((metric) => metric.getSnapshot());
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  /**
   * Unregister a metric
   */
  unregister(name: string, labels: MetricLabels = {}): boolean {
    const key = this.getMetricKey(name, labels);
    return this.metrics.delete(key);
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear();
  }

  /**
   * Thread-safe operation execution
   */
  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // Simple mutex implementation using Set
    while (this.mutex.has(key)) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    this.mutex.add(key);
    try {
      return await operation();
    } finally {
      this.mutex.delete(key);
    }
  }

  private getMetricKey(name: string, labels: MetricLabels): string {
    const labelPairs = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    return labelPairs ? `${name}{${labelPairs}}` : name;
  }
}

/**
 * Default registry instance
 */
export const defaultRegistry = new MetricsRegistry();

/**
 * Convenience functions for the default registry
 */
export function counter(name: string, help: string, labels?: MetricLabels): Counter {
  return defaultRegistry.getOrCreateCounter(name, help, labels);
}

export function gauge(name: string, help: string, labels?: MetricLabels): Gauge {
  return defaultRegistry.getOrCreateGauge(name, help, labels);
}

export function histogram(
  name: string,
  help: string,
  labels?: MetricLabels,
  buckets?: number[],
): Histogram {
  return defaultRegistry.getOrCreateHistogram(name, help, labels, buckets);
}

export function timer(name: string, help: string, labels?: MetricLabels): Timer {
  return defaultRegistry.getOrCreateTimer(name, help, labels);
}
