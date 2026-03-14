import type { GatewayManagementClient } from '@dash/mc';

export type GatewayStatus = 'starting' | 'healthy' | 'unhealthy' | 'restarting';

type EnsureGateway = () => Promise<GatewayManagementClient>;
type OnRestart = () => Promise<void>;

export class GatewayPoller {
  private timer: NodeJS.Timeout | null = null;
  private currentStatus: GatewayStatus = 'starting';

  constructor(
    private ensureGateway: EnsureGateway,
    private onRestart: OnRestart,
    private intervalMs: number = 5_000,
  ) {}

  start(onStatusChange: (status: GatewayStatus) => void): void {
    this.stop();
    this.timer = setInterval(async () => {
      try {
        const client = await this.ensureGateway();
        const health = await client.health();
        const newStatus: GatewayStatus = health.status === 'healthy' ? 'healthy' : 'unhealthy';
        if (newStatus !== this.currentStatus) {
          this.currentStatus = newStatus;
          onStatusChange(newStatus);
        }
      } catch {
        if (this.currentStatus !== 'restarting') {
          this.currentStatus = 'restarting';
          onStatusChange('restarting');
          try {
            await this.onRestart();
            this.currentStatus = 'healthy';
            onStatusChange('healthy');
          } catch {
            this.currentStatus = 'unhealthy';
            onStatusChange('unhealthy');
          }
        }
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getCurrentStatus(): GatewayStatus {
    return this.currentStatus;
  }
}
