import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import type { Context } from 'hono';
import { correlation } from './correlation.js';
import { type MetricLabels, type MetricsRegistry, defaultRegistry } from './metrics.js';

/**
 * Base interface for metric collectors
 */
export interface MetricCollector {
  readonly name: string;
  start(): void;
  stop(): void;
  collect(): void;
}

/**
 * Node.js process metrics collector
 */
export class ProcessMetricsCollector implements MetricCollector {
  public readonly name = 'process';
  private interval?: NodeJS.Timeout;
  private lastCpuUsage = process.cpuUsage();
  private lastTime = performance.now();

  constructor(
    private readonly registry: MetricsRegistry = defaultRegistry,
    private readonly collectIntervalMs = 5000,
  ) {}

  start(): void {
    if (this.interval) {
      return;
    }

    // Initialize metrics
    this.registry.getOrCreateGauge('nodejs_process_memory_rss_bytes', 'Resident set size in bytes');
    this.registry.getOrCreateGauge('nodejs_process_memory_heap_total_bytes', 'Heap total in bytes');
    this.registry.getOrCreateGauge('nodejs_process_memory_heap_used_bytes', 'Heap used in bytes');
    this.registry.getOrCreateGauge(
      'nodejs_process_memory_external_bytes',
      'External memory in bytes',
    );
    this.registry.getOrCreateGauge(
      'nodejs_process_cpu_user_seconds_total',
      'Total user CPU time spent in seconds',
    );
    this.registry.getOrCreateGauge(
      'nodejs_process_cpu_system_seconds_total',
      'Total system CPU time spent in seconds',
    );
    this.registry.getOrCreateGauge('nodejs_process_uptime_seconds', 'Process uptime in seconds');
    this.registry.getOrCreateGauge(
      'nodejs_process_start_time_seconds',
      'Start time of the process since unix epoch in seconds',
    );

    // Collect initial metrics
    this.collect();

    // Start periodic collection
    this.interval = setInterval(() => this.collect(), this.collectIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  collect(): void {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const currentTime = performance.now();

    // Memory metrics
    this.registry.getOrCreateGauge('nodejs_process_memory_rss_bytes', '').set(memUsage.rss);
    this.registry
      .getOrCreateGauge('nodejs_process_memory_heap_total_bytes', '')
      .set(memUsage.heapTotal);
    this.registry
      .getOrCreateGauge('nodejs_process_memory_heap_used_bytes', '')
      .set(memUsage.heapUsed);
    this.registry
      .getOrCreateGauge('nodejs_process_memory_external_bytes', '')
      .set(memUsage.external);

    // CPU metrics (convert microseconds to seconds)
    this.registry
      .getOrCreateGauge('nodejs_process_cpu_user_seconds_total', '')
      .set(cpuUsage.user / 1000000);
    this.registry
      .getOrCreateGauge('nodejs_process_cpu_system_seconds_total', '')
      .set(cpuUsage.system / 1000000);

    // Process info
    this.registry.getOrCreateGauge('nodejs_process_uptime_seconds', '').set(process.uptime());
    this.registry
      .getOrCreateGauge('nodejs_process_start_time_seconds', '')
      .set(Date.now() / 1000 - process.uptime());

    this.lastCpuUsage = cpuUsage;
    this.lastTime = currentTime;
  }
}

/**
 * HTTP request metrics collector
 */
export class HttpMetricsCollector implements MetricCollector {
  public readonly name = 'http';

  constructor(private readonly registry: MetricsRegistry = defaultRegistry) {}

  start(): void {
    // Initialize metrics
    this.registry.getOrCreateCounter('http_requests_total', 'Total number of HTTP requests');
    this.registry.getOrCreateHistogram(
      'http_request_duration_seconds',
      'HTTP request duration in seconds',
      {},
      [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    );
    this.registry.getOrCreateGauge(
      'http_requests_in_flight',
      'Current number of HTTP requests being processed',
    );
  }

  stop(): void {
    // Nothing to stop
  }

  collect(): void {
    // Metrics are collected by middleware
  }

  /**
   * Hono middleware for collecting HTTP metrics
   */
  middleware() {
    return async (c: Context, next: () => Promise<void>) => {
      const method = c.req.method;
      const path = c.req.path;
      const startTime = performance.now();

      // Increment in-flight requests
      const inFlightGauge = this.registry.getOrCreateGauge('http_requests_in_flight', '');
      inFlightGauge.inc();

      try {
        await next();

        const duration = (performance.now() - startTime) / 1000; // Convert to seconds
        const status = c.res.status.toString();

        const labels: MetricLabels = {
          method,
          path,
          status,
        };

        // Add correlation ID if available
        const correlationId = correlation.getId();
        if (correlationId) {
          labels.correlation_id = correlationId;
        }

        // Record metrics
        this.registry.getOrCreateCounter('http_requests_total', '', labels).inc();
        this.registry
          .getOrCreateHistogram('http_request_duration_seconds', '', labels)
          .observe(duration);
      } finally {
        // Decrement in-flight requests
        inFlightGauge.dec();
      }
    };
  }
}

/**
 * WebSocket connection metrics collector
 */
export class WebSocketMetricsCollector implements MetricCollector {
  public readonly name = 'websocket';
  private connections = new Set<string>();

  constructor(private readonly registry: MetricsRegistry = defaultRegistry) {}

  start(): void {
    // Initialize metrics
    this.registry.getOrCreateGauge(
      'websocket_connections_active',
      'Current number of active WebSocket connections',
    );
    this.registry.getOrCreateCounter(
      'websocket_connections_total',
      'Total number of WebSocket connections',
    );
    this.registry.getOrCreateCounter(
      'websocket_messages_sent_total',
      'Total number of WebSocket messages sent',
    );
    this.registry.getOrCreateCounter(
      'websocket_messages_received_total',
      'Total number of WebSocket messages received',
    );
    this.registry.getOrCreateHistogram(
      'websocket_message_size_bytes',
      'Size of WebSocket messages in bytes',
    );
  }

  stop(): void {
    this.connections.clear();
  }

  collect(): void {
    const activeGauge = this.registry.getOrCreateGauge('websocket_connections_active', '');
    activeGauge.set(this.connections.size);
  }

  /**
   * Track new WebSocket connection
   */
  onConnect(connectionId: string): void {
    this.connections.add(connectionId);
    this.registry.getOrCreateCounter('websocket_connections_total', '').inc();
    this.collect();
  }

  /**
   * Track WebSocket disconnection
   */
  onDisconnect(connectionId: string): void {
    this.connections.delete(connectionId);
    this.collect();
  }

  /**
   * Track sent message
   */
  onMessageSent(messageSize: number, labels: MetricLabels = {}): void {
    this.registry.getOrCreateCounter('websocket_messages_sent_total', '', labels).inc();
    this.registry
      .getOrCreateHistogram('websocket_message_size_bytes', '', labels)
      .observe(messageSize);
  }

  /**
   * Track received message
   */
  onMessageReceived(messageSize: number, labels: MetricLabels = {}): void {
    this.registry.getOrCreateCounter('websocket_messages_received_total', '', labels).inc();
    this.registry
      .getOrCreateHistogram('websocket_message_size_bytes', '', labels)
      .observe(messageSize);
  }
}

/**
 * Agent-specific metrics collector
 */
export class AgentMetricsCollector implements MetricCollector {
  public readonly name = 'agent';

  constructor(private readonly registry: MetricsRegistry = defaultRegistry) {}

  start(): void {
    // Initialize metrics
    this.registry.getOrCreateCounter(
      'agent_conversations_total',
      'Total number of agent conversations',
    );
    this.registry.getOrCreateGauge(
      'agent_conversations_active',
      'Current number of active agent conversations',
    );
    this.registry.getOrCreateCounter(
      'agent_messages_total',
      'Total number of agent messages processed',
    );
    this.registry.getOrCreateCounter('agent_tool_calls_total', 'Total number of agent tool calls');
    this.registry.getOrCreateCounter('agent_llm_requests_total', 'Total number of LLM requests');
    this.registry.getOrCreateHistogram(
      'agent_llm_request_duration_seconds',
      'Duration of LLM requests in seconds',
    );
    this.registry.getOrCreateHistogram(
      'agent_tool_execution_duration_seconds',
      'Duration of tool executions in seconds',
    );
    this.registry.getOrCreateCounter('agent_llm_tokens_total', 'Total number of tokens processed');
    this.registry.getOrCreateCounter('agent_errors_total', 'Total number of agent errors');
  }

  stop(): void {
    // Nothing to stop
  }

  collect(): void {
    // Metrics are collected by agent operations
  }

  /**
   * Track conversation start
   */
  onConversationStart(agentId: string, channelId?: string): void {
    const labels: MetricLabels = { agent_id: agentId };
    if (channelId) {
      labels.channel_id = channelId;
    }

    this.registry.getOrCreateCounter('agent_conversations_total', '', labels).inc();
    this.registry.getOrCreateGauge('agent_conversations_active', '', labels).inc();
  }

  /**
   * Track conversation end
   */
  onConversationEnd(agentId: string, channelId?: string): void {
    const labels: MetricLabels = { agent_id: agentId };
    if (channelId) {
      labels.channel_id = channelId;
    }

    this.registry.getOrCreateGauge('agent_conversations_active', '', labels).dec();
  }

  /**
   * Track message processing
   */
  onMessage(
    agentId: string,
    messageType: 'user' | 'assistant' | 'system',
    channelId?: string,
  ): void {
    const labels: MetricLabels = {
      agent_id: agentId,
      message_type: messageType,
    };
    if (channelId) {
      labels.channel_id = channelId;
    }

    this.registry.getOrCreateCounter('agent_messages_total', '', labels).inc();
  }

  /**
   * Track tool call
   */
  onToolCall(agentId: string, toolName: string, duration: number, success: boolean): void {
    const labels: MetricLabels = {
      agent_id: agentId,
      tool_name: toolName,
      success: success.toString(),
    };

    this.registry.getOrCreateCounter('agent_tool_calls_total', '', labels).inc();
    this.registry
      .getOrCreateHistogram('agent_tool_execution_duration_seconds', '', labels)
      .observe(duration / 1000);
  }

  /**
   * Track LLM request
   */
  onLlmRequest(
    agentId: string,
    model: string,
    duration: number,
    inputTokens: number,
    outputTokens: number,
    success: boolean,
  ): void {
    const labels: MetricLabels = {
      agent_id: agentId,
      model,
      success: success.toString(),
    };

    this.registry.getOrCreateCounter('agent_llm_requests_total', '', labels).inc();
    this.registry
      .getOrCreateHistogram('agent_llm_request_duration_seconds', '', labels)
      .observe(duration / 1000);

    // Track tokens separately for input and output
    this.registry
      .getOrCreateCounter('agent_llm_tokens_total', '', { ...labels, token_type: 'input' })
      .inc(inputTokens);
    this.registry
      .getOrCreateCounter('agent_llm_tokens_total', '', { ...labels, token_type: 'output' })
      .inc(outputTokens);
  }

  /**
   * Track agent error
   */
  onError(agentId: string, errorType: string, channelId?: string): void {
    const labels: MetricLabels = {
      agent_id: agentId,
      error_type: errorType,
    };
    if (channelId) {
      labels.channel_id = channelId;
    }

    this.registry.getOrCreateCounter('agent_errors_total', '', labels).inc();
  }
}

/**
 * Collection manager for coordinating multiple collectors
 */
export class MetricsCollectionManager extends EventEmitter {
  private collectors = new Map<string, MetricCollector>();
  private started = false;

  constructor(private readonly registry: MetricsRegistry = defaultRegistry) {
    super();
  }

  /**
   * Register a collector
   */
  register(collector: MetricCollector): void {
    if (this.collectors.has(collector.name)) {
      throw new Error(`Collector already registered: ${collector.name}`);
    }

    this.collectors.set(collector.name, collector);

    if (this.started) {
      collector.start();
    }
  }

  /**
   * Unregister a collector
   */
  unregister(name: string): boolean {
    const collector = this.collectors.get(name);
    if (collector) {
      collector.stop();
      this.collectors.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Get a registered collector
   */
  get<T extends MetricCollector>(name: string): T | undefined {
    return this.collectors.get(name) as T | undefined;
  }

  /**
   * Start all collectors
   */
  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;

    for (const collector of this.collectors.values()) {
      try {
        collector.start();
        this.emit('collector:started', collector.name);
      } catch (error) {
        this.emit('collector:error', collector.name, error);
      }
    }
  }

  /**
   * Stop all collectors
   */
  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;

    for (const collector of this.collectors.values()) {
      try {
        collector.stop();
        this.emit('collector:stopped', collector.name);
      } catch (error) {
        this.emit('collector:error', collector.name, error);
      }
    }
  }

  /**
   * Trigger collection on all collectors
   */
  collect(): void {
    for (const collector of this.collectors.values()) {
      try {
        collector.collect();
      } catch (error) {
        this.emit('collector:error', collector.name, error);
      }
    }
  }

  /**
   * Get all registered collectors
   */
  getAll(): MetricCollector[] {
    return Array.from(this.collectors.values());
  }
}

/**
 * Default collection manager with standard collectors
 */
export function createDefaultCollectionManager(): MetricsCollectionManager {
  const manager = new MetricsCollectionManager();

  // Register standard collectors
  manager.register(new ProcessMetricsCollector());
  manager.register(new HttpMetricsCollector());
  manager.register(new WebSocketMetricsCollector());
  manager.register(new AgentMetricsCollector());

  return manager;
}

/**
 * Export singleton instances for convenience
 */
export const defaultCollectionManager = createDefaultCollectionManager();
export const processMetrics = defaultCollectionManager.get<ProcessMetricsCollector>('process');
export const httpMetrics = defaultCollectionManager.get<HttpMetricsCollector>('http');
export const webSocketMetrics =
  defaultCollectionManager.get<WebSocketMetricsCollector>('websocket');
export const agentMetrics = defaultCollectionManager.get<AgentMetricsCollector>('agent');
