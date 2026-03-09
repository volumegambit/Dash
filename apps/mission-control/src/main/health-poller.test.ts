import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthPoller } from './health-poller.js';

// Mock the ManagementClient
vi.mock('@dash/management', () => ({
  ManagementClient: vi.fn(),
}));

import { ManagementClient } from '@dash/management';

const MockedManagementClient = vi.mocked(ManagementClient);

describe('HealthPoller', () => {
  let poller: HealthPoller;
  let mockHealth: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    poller = new HealthPoller();
    mockHealth = vi.fn();
    MockedManagementClient.mockImplementation(() => ({
      health: mockHealth,
    }) as unknown as InstanceType<typeof ManagementClient>);
  });

  afterEach(() => {
    poller.stopAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('polls every 15s and calls onStatusChange when status changes', async () => {
    mockHealth.mockResolvedValue({ status: 'healthy', uptime: 100, version: '1.0' });
    const onStatusChange = vi.fn();

    poller.start('dep1', 3000, 'token123', onStatusChange);

    // No calls yet (interval hasn't fired)
    expect(onStatusChange).not.toHaveBeenCalled();

    // Advance 15s
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('healthy');

    // Change status on next poll
    mockHealth.mockResolvedValue({ status: 'healthy', uptime: 200, version: '1.0' });

    await vi.advanceTimersByTimeAsync(15_000);
    // Status hasn't changed — still 'healthy'
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onStatusChange when status is unchanged', async () => {
    mockHealth.mockResolvedValue({ status: 'healthy', uptime: 100, version: '1.0' });
    const onStatusChange = vi.fn();

    poller.start('dep1', 3000, 'token123', onStatusChange);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    // Still 'healthy' — no additional call
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('stops polling for a given id when stop() is called', async () => {
    mockHealth.mockResolvedValue({ status: 'healthy', uptime: 100, version: '1.0' });
    const onStatusChange = vi.fn();

    poller.start('dep1', 3000, 'token123', onStatusChange);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    poller.stop('dep1');

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    // No more calls after stop
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('stopAll() stops all active pollers', async () => {
    mockHealth.mockResolvedValue({ status: 'healthy', uptime: 100, version: '1.0' });
    const onStatusChange1 = vi.fn();
    const onStatusChange2 = vi.fn();

    poller.start('dep1', 3000, 'token1', onStatusChange1);
    poller.start('dep2', 3001, 'token2', onStatusChange2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange1).toHaveBeenCalledTimes(1);
    expect(onStatusChange2).toHaveBeenCalledTimes(1);

    poller.stopAll();

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    // No additional calls after stopAll
    expect(onStatusChange1).toHaveBeenCalledTimes(1);
    expect(onStatusChange2).toHaveBeenCalledTimes(1);
  });

  it('calls onStatusChange("error") on health check failure and does not repeat if already error', async () => {
    mockHealth.mockRejectedValue(new Error('Connection refused'));
    const onStatusChange = vi.fn();

    poller.start('dep1', 3000, 'token123', onStatusChange);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('error');

    // Still failing — should NOT call onStatusChange again since status is already 'error'
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('calls onStatusChange when status recovers from error', async () => {
    mockHealth.mockRejectedValueOnce(new Error('Connection refused'));
    mockHealth.mockResolvedValue({ status: 'healthy', uptime: 100, version: '1.0' });
    const onStatusChange = vi.fn();

    poller.start('dep1', 3000, 'token123', onStatusChange);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledWith('error');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledWith('healthy');
    expect(onStatusChange).toHaveBeenCalledTimes(2);
  });

  it('resets lastStatus on stop() so restart triggers onStatusChange again', async () => {
    mockHealth.mockResolvedValue({ status: 'healthy', uptime: 100, version: '1.0' });
    const onStatusChange = vi.fn();

    poller.start('dep1', 3000, 'token123', onStatusChange);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    poller.stop('dep1');

    // Restart — lastStatus was cleared, so it should fire again
    poller.start('dep1', 3000, 'token123', onStatusChange);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
  });
});
