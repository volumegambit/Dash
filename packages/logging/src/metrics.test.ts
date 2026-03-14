import { beforeEach, describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, MetricsRegistry, Timer, defaultRegistry } from './metrics.js';

describe('Metrics System', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe('Counter', () => {
    it('should increment correctly', () => {
      const counter = new Counter('test_counter', 'Test counter');

      expect(counter.getValue()).toBe(0);

      counter.inc();
      expect(counter.getValue()).toBe(1);

      counter.inc(5);
      expect(counter.getValue()).toBe(6);
    });

    it('should not allow negative increments', () => {
      const counter = new Counter('test_counter', 'Test counter');

      expect(() => counter.inc(-1)).toThrow('Counter increment must be non-negative');
    });

    it('should reset correctly', () => {
      const counter = new Counter('test_counter', 'Test counter');
      counter.inc(10);

      expect(counter.getValue()).toBe(10);

      counter.reset();
      expect(counter.getValue()).toBe(0);
    });
  });

  describe('Gauge', () => {
    it('should set, increment, and decrement correctly', () => {
      const gauge = new Gauge('test_gauge', 'Test gauge');

      expect(gauge.getValue()).toBe(0);

      gauge.set(10);
      expect(gauge.getValue()).toBe(10);

      gauge.inc(5);
      expect(gauge.getValue()).toBe(15);

      gauge.dec(3);
      expect(gauge.getValue()).toBe(12);
    });
  });

  describe('Histogram', () => {
    it('should observe values and calculate statistics', () => {
      const histogram = new Histogram('test_histogram', 'Test histogram');

      histogram.observe(0.1);
      histogram.observe(0.2);
      histogram.observe(0.5);
      histogram.observe(1.0);

      const snapshot = histogram.getValue();
      expect(snapshot.count).toBe(4);
      expect(snapshot.sum).toBe(1.8);
      expect(snapshot.buckets.length).toBeGreaterThan(0);
      expect(snapshot.quantiles?.['0.5']).toBe(0.5); // The median of [0.1, 0.2, 0.5, 1.0]
    });
  });

  describe('Timer', () => {
    it('should record timing measurements', () => {
      const timer = new Timer('test_timer', 'Test timer');

      timer.record(100);
      timer.record(200);
      timer.record(150);

      const snapshot = timer.getValue();
      expect(snapshot.count).toBe(3);
      expect(snapshot.sum).toBe(450);
      expect(snapshot.mean).toBe(150);
      expect(snapshot.min).toBe(100);
      expect(snapshot.max).toBe(200);
    });

    it('should time function execution', () => {
      const timer = new Timer('test_timer', 'Test timer');

      const result = timer.time(() => {
        // Simulate some work
        return 'result';
      });

      expect(result).toBe('result');

      const snapshot = timer.getValue();
      expect(snapshot.count).toBe(1);
      expect(snapshot.sum).toBeGreaterThan(0);
    });

    it('should time async function execution', async () => {
      const timer = new Timer('test_timer', 'Test timer');

      const result = await timer.timeAsync(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return 'async result';
      });

      expect(result).toBe('async result');

      const snapshot = timer.getValue();
      expect(snapshot.count).toBe(1);
      expect(snapshot.sum).toBeGreaterThan(0);
    });
  });

  describe('MetricsRegistry', () => {
    it('should register and retrieve metrics', () => {
      const counter = new Counter('test_counter', 'Test counter');

      registry.register(counter);

      const retrieved = registry.get<Counter>('test_counter');
      expect(retrieved).toBe(counter);
    });

    it('should prevent duplicate registration', () => {
      const counter1 = new Counter('test_counter', 'Test counter 1');
      const counter2 = new Counter('test_counter', 'Test counter 2');

      registry.register(counter1);

      expect(() => registry.register(counter2)).toThrow('Metric already registered');
    });

    it('should get or create metrics', () => {
      const counter1 = registry.getOrCreateCounter('test_counter', 'Test counter');
      const counter2 = registry.getOrCreateCounter('test_counter', 'Test counter');

      expect(counter1).toBe(counter2);
    });

    it('should handle metrics with labels', () => {
      const labels1 = { method: 'GET', status: '200' };
      const labels2 = { method: 'POST', status: '201' };

      const counter1 = registry.getOrCreateCounter('http_requests', 'HTTP requests', labels1);
      const counter2 = registry.getOrCreateCounter('http_requests', 'HTTP requests', labels2);

      expect(counter1).not.toBe(counter2);

      counter1.inc();
      counter2.inc(2);

      expect(counter1.getValue()).toBe(1);
      expect(counter2.getValue()).toBe(2);
    });

    it('should get all metrics snapshots', () => {
      const counter = registry.getOrCreateCounter('test_counter', 'Test counter');
      const gauge = registry.getOrCreateGauge('test_gauge', 'Test gauge');

      counter.inc(5);
      gauge.set(10);

      const snapshots = registry.getAllSnapshots();
      expect(snapshots).toHaveLength(2);

      const counterSnapshot = snapshots.find((s) => s.name === 'test_counter');
      const gaugeSnapshot = snapshots.find((s) => s.name === 'test_gauge');

      expect(counterSnapshot?.value).toBe(5);
      expect(gaugeSnapshot?.value).toBe(10);
    });

    it('should reset all metrics', () => {
      const counter = registry.getOrCreateCounter('test_counter', 'Test counter');
      const gauge = registry.getOrCreateGauge('test_gauge', 'Test gauge');

      counter.inc(5);
      gauge.set(10);

      registry.reset();

      expect(counter.getValue()).toBe(0);
      expect(gauge.getValue()).toBe(0);
    });
  });

  describe('Default Registry', () => {
    it('should provide convenience functions', async () => {
      // Import convenience functions
      const { counter, gauge, histogram, timer } = await import('./metrics.js');

      const testCounter = counter('convenience_counter', 'Convenience counter');
      const testGauge = gauge('convenience_gauge', 'Convenience gauge');
      const testHistogram = histogram('convenience_histogram', 'Convenience histogram');
      const testTimer = timer('convenience_timer', 'Convenience timer');

      expect(testCounter.name).toBe('convenience_counter');
      expect(testGauge.name).toBe('convenience_gauge');
      expect(testHistogram.name).toBe('convenience_histogram');
      expect(testTimer.name).toBe('convenience_timer');

      // Clean up default registry
      defaultRegistry.clear();
    });
  });
});
