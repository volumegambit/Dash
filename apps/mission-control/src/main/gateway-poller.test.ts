import type { GatewayManagementClient } from '@dash/mc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayPoller } from './gateway-poller.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('GatewayPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls onStatusChange with healthy when ensureGateway resolves and health returns healthy', async () => {
    const health = { status: 'healthy' as const, startedAt: 't', agents: 0, channels: 0 };
    const mockClient = {
      health: vi.fn().mockResolvedValue(health),
    } as unknown as GatewayManagementClient;
    const mockEnsure = vi.fn().mockResolvedValue(mockClient);
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(mockEnsure, 5000);
    poller.start(onStatusChange);

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockEnsure).toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith('healthy', health);
    poller.stop();
  });

  it('calls onStatusChange with unhealthy when ensureGateway throws', async () => {
    const mockEnsure = vi.fn().mockRejectedValue(new Error('gateway down'));
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(mockEnsure, 5000);
    poller.start(onStatusChange);

    await vi.advanceTimersByTimeAsync(5000);

    expect(onStatusChange).toHaveBeenCalledWith('unhealthy');
    poller.stop();
  });

  it('does not call onStatusChange again if status has not changed', async () => {
    const mockClient = {
      health: vi
        .fn()
        .mockResolvedValue({ status: 'healthy', startedAt: 't', agents: 0, channels: 0 }),
    } as unknown as GatewayManagementClient;
    const mockEnsure = vi.fn().mockResolvedValue(mockClient);
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(mockEnsure, 5000);
    poller.start(onStatusChange);

    await vi.advanceTimersByTimeAsync(10000); // two ticks

    expect(onStatusChange).toHaveBeenCalledTimes(1); // only first time (starting → healthy)
    poller.stop();
  });

  it('passes an unhealthy health response on a successful status transition', async () => {
    const health = { status: 'unhealthy' as const, startedAt: 't', agents: 0, channels: 0 };
    const mockClient = {
      health: vi.fn().mockResolvedValue(health),
    } as unknown as GatewayManagementClient;
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(vi.fn().mockResolvedValue(mockClient), 5000);
    poller.start(onStatusChange);
    await vi.advanceTimersByTimeAsync(5000);

    expect(onStatusChange).toHaveBeenCalledWith('unhealthy', health);
    poller.stop();
  });

  it('transitions to unhealthy when a previously available client disappears', async () => {
    const health = { status: 'healthy' as const, startedAt: 't', agents: 0, channels: 0 };
    const client = {
      health: vi.fn().mockResolvedValue(health),
    } as unknown as GatewayManagementClient;
    const ensureGateway = vi.fn().mockResolvedValueOnce(client).mockResolvedValueOnce(null);
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(ensureGateway, 5000);
    poller.start(onStatusChange);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onStatusChange).toHaveBeenNthCalledWith(1, 'healthy', health);
    expect(onStatusChange).toHaveBeenNthCalledWith(2, 'unhealthy');
    expect(poller.getCurrentStatus()).toBe('unhealthy');
    poller.stop();
  });

  it('ignores a stale slower tick after a newer health result is applied', async () => {
    const slowHealth = deferred<{
      status: 'healthy';
      startedAt: string;
      agents: number;
      channels: number;
    }>();
    const healthyClient = { health: vi.fn(() => slowHealth.promise) };
    const unhealthy = { status: 'unhealthy' as const, startedAt: 't', agents: 0, channels: 0 };
    const unhealthyClient = { health: vi.fn().mockResolvedValue(unhealthy) };
    const ensureGateway = vi
      .fn()
      .mockResolvedValueOnce(healthyClient)
      .mockResolvedValueOnce(unhealthyClient);
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(ensureGateway as never, 5000);
    poller.start(onStatusChange);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onStatusChange).toHaveBeenCalledWith('unhealthy', unhealthy);

    slowHealth.resolve({ status: 'healthy', startedAt: 'old', agents: 0, channels: 0 });
    await Promise.resolve();

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(poller.getCurrentStatus()).toBe('unhealthy');
    poller.stop();
  });

  it('accepts the oldest in-flight result until a newer tick has actually applied', async () => {
    const firstHealth = deferred<{
      status: 'healthy';
      startedAt: string;
      agents: number;
      channels: number;
    }>();
    const secondHealth = deferred<{
      status: 'healthy';
      startedAt: string;
      agents: number;
      channels: number;
    }>();
    const ensureGateway = vi
      .fn()
      .mockResolvedValueOnce({ health: vi.fn(() => firstHealth.promise) })
      .mockResolvedValueOnce({ health: vi.fn(() => secondHealth.promise) });
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(ensureGateway as never, 5000);
    poller.start(onStatusChange);
    await vi.advanceTimersByTimeAsync(10_000);

    firstHealth.resolve({ status: 'healthy', startedAt: 'first', agents: 0, channels: 0 });
    await Promise.resolve();
    expect(onStatusChange).toHaveBeenCalledOnce();

    secondHealth.resolve({ status: 'healthy', startedAt: 'second', agents: 0, channels: 0 });
    await Promise.resolve();
    expect(onStatusChange).toHaveBeenCalledOnce();
    poller.stop();
  });

  it('ignores an in-flight health result after stop', async () => {
    const pendingHealth = deferred<{
      status: 'healthy';
      startedAt: string;
      agents: number;
      channels: number;
    }>();
    const client = { health: vi.fn(() => pendingHealth.promise) };
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(vi.fn().mockResolvedValue(client) as never, 5000);
    poller.start(onStatusChange);
    await vi.advanceTimersByTimeAsync(5000);
    poller.stop();
    pendingHealth.resolve({ status: 'healthy', startedAt: 'late', agents: 0, channels: 0 });
    await Promise.resolve();

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('does not call onStatusChange again after already unhealthy', async () => {
    const mockEnsure = vi.fn().mockRejectedValue(new Error('down'));
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(mockEnsure, 5000);
    poller.start(onStatusChange);

    await vi.advanceTimersByTimeAsync(10000); // two ticks — both fail

    expect(onStatusChange).toHaveBeenCalledTimes(1); // only first failure (starting → unhealthy)
    poller.stop();
  });

  it('stop() prevents further polling', async () => {
    const mockEnsure = vi.fn().mockRejectedValue(new Error('down'));
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(mockEnsure, 5000);
    poller.start(onStatusChange);
    poller.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockEnsure).not.toHaveBeenCalled();
    poller.stop();
  });

  it('getCurrentStatus returns current status', () => {
    const mockEnsure = vi.fn();
    const poller = new GatewayPoller(mockEnsure, 5000);
    expect(poller.getCurrentStatus()).toBe('starting');
  });
});
