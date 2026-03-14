import {
  correlation,
  createDevelopmentLogger,
  createLogger,
  createProductionLogger,
} from './index.js';

/**
 * Example usage of the structured logging package
 */
async function demonstrateLogging() {
  console.log('=== Development Logger Example ===');

  const devLogger = createDevelopmentLogger('example-service');

  devLogger.info('Application starting', { version: '1.0.0' });
  devLogger.debug('Debug information', { details: { key: 'value' } });
  devLogger.warn('Warning message', { concern: 'memory-usage' });
  devLogger.error('Error occurred', new Error('Something went wrong'), { userId: '123' });

  console.log('\n=== Correlation ID Example ===');

  // Use correlation to track requests across async operations
  await correlation.runWithNewIdAsync(async () => {
    devLogger.info('Request started');

    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 10));

    devLogger.info('Processing data');

    // Add metadata to correlation context
    correlation.addMetadata({ userId: 'user-123', operation: 'data-processing' });

    devLogger.info('Request completed');
  });

  console.log('\n=== Performance Metrics Example ===');

  const perfLogger = createLogger({
    level: 'info',
    component: 'performance-service',
    enablePerformanceMetrics: true,
    outputs: [{ type: 'console', format: 'text' }],
  });

  // Measure performance of sync function
  const result = perfLogger.withMetrics('Expensive calculation', () => {
    // Simulate CPU intensive work
    let sum = 0;
    for (let i = 0; i < 1000000; i++) {
      sum += i;
    }
    return sum;
  });

  console.log(`Calculation result: ${result}`);

  // Measure performance of async function
  await perfLogger.withMetricsAsync('Async operation', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return 'completed';
  });

  console.log('\n=== Child Logger Example ===');

  const parentLogger = createDevelopmentLogger('parent-service');
  const childLogger = parentLogger.child({
    requestId: 'req-456',
    module: 'user-handler',
  });

  parentLogger.info('Parent logger message');
  childLogger.info('Child logger message with additional context');

  console.log('\n=== JSON Output Example ===');

  const jsonLogger = createLogger({
    level: 'info',
    component: 'json-service',
    outputs: [{ type: 'console', format: 'json' }],
  });

  await correlation.runWithNewIdAsync(async () => {
    jsonLogger.info('Structured log entry', {
      userId: 'user-789',
      action: 'login',
      metadata: { ip: '192.168.1.1', userAgent: 'TestAgent/1.0' },
    });
  });
}

// Run the examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateLogging().catch(console.error);
}
