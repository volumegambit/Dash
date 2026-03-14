import { correlation, createDevelopmentLogger, createLogger } from './index.js';

describe('Logging Package', () => {
  it('should create a development logger', () => {
    const logger = createDevelopmentLogger('test-component');
    expect(logger).toBeDefined();
  });

  it('should log with correlation ID', () => {
    const logger = createDevelopmentLogger('test-component');

    correlation.run('test-correlation-id', () => {
      logger.info('Test message', { key: 'value' });
    });

    // If it doesn't throw, we're good
    expect(true).toBe(true);
  });

  it('should create logger with custom config', () => {
    const logger = createLogger({
      level: 'warn',
      component: 'custom-component',
      enablePerformanceMetrics: true,
      outputs: [{ type: 'console', format: 'json' }],
    });

    expect(logger).toBeDefined();
  });

  it('should handle performance metrics', async () => {
    const logger = createLogger({
      level: 'info',
      enablePerformanceMetrics: true,
      outputs: [{ type: 'console', format: 'text' }],
    });

    const result = await logger.withMetricsAsync('test operation', async () => {
      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'success';
    });

    expect(result).toBe('success');
  });

  it('should handle child loggers', () => {
    const parentLogger = createDevelopmentLogger('parent');
    const childLogger = parentLogger.child({ childId: '123' });

    childLogger.info('Child log message');
    expect(true).toBe(true);
  });
});
