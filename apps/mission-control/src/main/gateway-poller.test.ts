import type { GatewayManagementClient } from '@dash/mc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayPoller } from './gateway-poller.js';

describe('GatewayPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls onStatusChange with healthy when ensureGateway resolves and health returns healthy', async () => {
    const mockClient = {
      health: vi
        .fn()
        .mockResolvedValue({ status: 'healthy', startedAt: 't', agents: 0, channels: 0 }),
    } as unknown as GatewayManagementClient;
    const mockEnsure = vi.fn().mockResolvedValue(mockClient);
    const onStatusChange = vi.fn();

    const poller = new GatewayPoller(mockEnsure, 5000);
    poller.start(onStatusChange);

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockEnsure).toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith('healthy');
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
