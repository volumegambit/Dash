/**
 * Example usage of the Dash metrics collection system
 */

import {
  agentMetrics,
  // Core metrics functions
  counter,
  createJsonReporter,
  createPeriodicReporter,
  createPrometheusReporter,
  // Collectors
  defaultCollectionManager,
  // Reporters
  defaultExportManager,
  defaultRegistry,
  gauge,
  histogram,
  httpMetrics,
  processMetrics,
  timer,
  webSocketMetrics,
} from './index.js';

/**
 * Basic metrics usage
 */
function basicMetricsExample() {
  console.log('=== Basic Metrics Example ===');

  // Create metrics using convenience functions
  const requestCounter = counter('http_requests_total', 'Total HTTP requests');
  const memoryGauge = gauge('memory_usage_bytes', 'Current memory usage in bytes');
  const responseTimeHistogram = histogram(
    'http_response_time_seconds',
    'HTTP response time in seconds',
  );
  const processingTimer = timer('request_processing_time', 'Request processing time');

  // Use the metrics
  requestCounter.inc(); // Increment by 1
  requestCounter.inc(5); // Increment by 5

  memoryGauge.set(1024 * 1024 * 128); // 128MB
  memoryGauge.inc(1024 * 1024); // Add 1MB

  responseTimeHistogram.observe(0.15); // 150ms response
  responseTimeHistogram.observe(0.3); // 300ms response
  responseTimeHistogram.observe(0.075); // 75ms response

  processingTimer.record(125.5); // Record 125.5ms processing time

  // Time a function
  const result = processingTimer.time(() => {
    // Simulate some work
    const sum = Array.from({ length: 10000 }, (_, i) => i).reduce((a, b) => a + b, 0);
    return sum;
  });

  console.log('Function result:', result);
  console.log('Request counter value:', requestCounter.getValue());
  console.log('Memory gauge value:', memoryGauge.getValue());
  console.log('Response time histogram stats:', responseTimeHistogram.getValue());
  console.log('Processing timer stats:', processingTimer.getValue());
}

/**
 * Metrics with labels example
 */
function labeledMetricsExample() {
  console.log('\n=== Labeled Metrics Example ===');

  // Create metrics with labels
  const httpCounter = counter('http_requests_total', 'HTTP requests', {
    method: 'GET',
    status: '200',
    endpoint: '/api/users',
  });

  const errorCounter = counter('http_requests_total', 'HTTP requests', {
    method: 'POST',
    status: '500',
    endpoint: '/api/users',
  });

  // Different metrics for different label combinations
  httpCounter.inc(10);
  errorCounter.inc(2);

  console.log('GET 200 requests:', httpCounter.getValue());
  console.log('POST 500 requests:', errorCounter.getValue());

  // Show all metrics in registry
  const snapshots = defaultRegistry.getAllSnapshots();
  console.log('Total metrics in registry:', snapshots.length);
}

/**
 * System collectors example
 */
async function systemCollectorsExample() {
  console.log('\n=== System Collectors Example ===');

  // Start the default collection manager
  defaultCollectionManager.start();

  // Wait a moment for process metrics to be collected
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Simulate some HTTP activity
  if (httpMetrics) {
    httpMetrics.start();
  }

  // Simulate WebSocket activity
  if (webSocketMetrics) {
    webSocketMetrics.start();
    webSocketMetrics.onConnect('connection-1');
    webSocketMetrics.onConnect('connection-2');
    webSocketMetrics.onMessageSent(1024, { type: 'chat' });
    webSocketMetrics.onMessageReceived(512, { type: 'ack' });
  }

  // Simulate agent activity
  if (agentMetrics) {
    agentMetrics.start();
    agentMetrics.onConversationStart('agent-1', 'discord');
    agentMetrics.onMessage('agent-1', 'user', 'discord');
    agentMetrics.onMessage('agent-1', 'assistant', 'discord');
    agentMetrics.onToolCall('agent-1', 'search', 250, true);
    agentMetrics.onLlmRequest('agent-1', 'claude-3-sonnet', 1500, 100, 50, true);
  }

  // Show collected metrics
  const allMetrics = defaultRegistry.getAllSnapshots();
  console.log('Collected metrics:', allMetrics.length);

  // Show some specific metrics
  const processMemory = allMetrics.find((m) => m.name === 'nodejs_process_memory_rss_bytes');
  if (processMemory) {
    console.log('Process RSS memory:', processMemory.value, 'bytes');
  }

  const wsConnections = allMetrics.find((m) => m.name === 'websocket_connections_active');
  if (wsConnections) {
    console.log('Active WebSocket connections:', wsConnections.value);
  }
}

/**
 * Metrics reporting example
 */
async function reportingExample() {
  console.log('\n=== Metrics Reporting Example ===');

  // JSON export
  const jsonReporter = createJsonReporter(defaultRegistry, {
    prettyPrint: true,
    includeMetadata: true,
    includeEmpty: false,
  });

  const jsonOutput = await jsonReporter.export();
  console.log('JSON export (first 500 chars):');
  console.log(`${jsonOutput.substring(0, 500)}...`);

  // Prometheus export
  const prometheusReporter = createPrometheusReporter(defaultRegistry);
  const prometheusOutput = await prometheusReporter.export();
  console.log('\nPrometheus export (first 500 chars):');
  console.log(`${prometheusOutput.substring(0, 500)}...`);

  // Periodic reporting example (commented out to avoid running indefinitely)
  /*
  const periodicReporter = createPeriodicReporter(jsonReporter, {
    intervalMs: 5000, // Export every 5 seconds
    includeTimestamp: true,
  });

  periodicReporter.on('report', (output, duration) => {
    console.log(`Metrics exported in ${duration}ms`);
  });

  periodicReporter.on('error', (error) => {
    console.error('Reporting error:', error);
  });

  periodicReporter.start();
  
  // Stop after 15 seconds
  setTimeout(() => {
    periodicReporter.stop();
    console.log('Periodic reporting stopped');
  }, 15000);
  */
}

/**
 * Performance timing example
 */
async function performanceTimingExample() {
  console.log('\n=== Performance Timing Example ===');

  const dbQueryTimer = timer('db_query_duration', 'Database query duration');
  const apiCallTimer = timer('api_call_duration', 'External API call duration');

  // Time synchronous operations
  const syncResult = dbQueryTimer.time(() => {
    // Simulate database query
    const data = Array.from({ length: 100000 }, () => Math.random());
    return data.reduce((sum, val) => sum + val, 0);
  });

  console.log('Sync operation result:', syncResult);

  // Time asynchronous operations
  const asyncResult = await apiCallTimer.timeAsync(async () => {
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { success: true, data: 'API response' };
  });

  console.log('Async operation result:', asyncResult);

  // Manual timing with start/stop
  const operationTimer = timer('manual_operation', 'Manual timing example');
  const stopTimer = operationTimer.startTimer();

  // Simulate some work
  await new Promise((resolve) => setTimeout(resolve, 50));

  stopTimer(); // Stop the timer

  // Show timing stats
  console.log('DB query timer stats:', dbQueryTimer.getValue());
  console.log('API call timer stats:', apiCallTimer.getValue());
  console.log('Manual operation timer stats:', operationTimer.getValue());
}

/**
 * Run all examples
 */
async function runExamples() {
  try {
    basicMetricsExample();
    labeledMetricsExample();
    await systemCollectorsExample();
    await reportingExample();
    await performanceTimingExample();

    console.log('\n=== Examples completed successfully ===');
  } catch (error) {
    console.error('Error running examples:', error);
  } finally {
    // Clean up
    defaultCollectionManager.stop();
    defaultRegistry.reset();
  }
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExamples();
}

export {
  basicMetricsExample,
  labeledMetricsExample,
  systemCollectorsExample,
  reportingExample,
  performanceTimingExample,
  runExamples,
};
