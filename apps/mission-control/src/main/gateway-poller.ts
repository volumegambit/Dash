import type { GatewayHealthResponse, GatewayManagementClient } from '@dash/mc';

export type GatewayStatus = 'starting' | 'healthy' | 'unhealthy';

type EnsureGateway = () => Promise<GatewayManagementClient | null>;

export class GatewayPoller {
  private timer: NodeJS.Timeout | null = null;
  private currentStatus: GatewayStatus = 'starting';
  private lastMcpStatuses = new Map<string, string>();
  private runGeneration = 0;
  private latestTick = 0;

  constructor(
    private ensureGateway: EnsureGateway,
    private intervalMs = 5_000,
  ) {}

  start(
    onStatusChange: (status: GatewayStatus, health?: GatewayHealthResponse) => void,
    onMcpStatusChange?: (serverName: string, status: string) => void,
  ): void {
    this.stop();
    const runGeneration = this.runGeneration;
    let lastAppliedTick = this.latestTick;
    this.timer = setInterval(async () => {
      const tick = ++this.latestTick;
      const isActive = (): boolean => this.timer !== null && this.runGeneration === runGeneration;
      const isFresh = (): boolean => isActive() && tick > lastAppliedTick;
      const claimResult = (): boolean => {
        if (!isFresh()) return false;
        lastAppliedTick = tick;
        return true;
      };
      try {
        const client = await this.ensureGateway();
        if (!isFresh()) return;
        if (!client) {
          if (!claimResult()) return;
          if (this.currentStatus !== 'unhealthy') {
            this.currentStatus = 'unhealthy';
            onStatusChange('unhealthy');
          }
          return;
        }
        const health = await client.health();
        if (!claimResult()) return;
        const newStatus: GatewayStatus = health.status === 'healthy' ? 'healthy' : 'unhealthy';
        if (newStatus !== this.currentStatus) {
          this.currentStatus = newStatus;
          onStatusChange(newStatus, health);
        }

        // Track MCP server statuses
        if (onMcpStatusChange && health.mcpServers) {
          for (const server of health.mcpServers) {
            const prev = this.lastMcpStatuses.get(server.name);
            if (server.status !== prev) {
              this.lastMcpStatuses.set(server.name, server.status);
              onMcpStatusChange(server.name, server.status);
            }
          }
        }
      } catch {
        if (!claimResult()) return;
        if (this.currentStatus !== 'unhealthy') {
          this.currentStatus = 'unhealthy';
          onStatusChange('unhealthy');
        }
      }
    }, this.intervalMs);
  }

  stop(): void {
    this.runGeneration++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastMcpStatuses.clear();
  }

  getCurrentStatus(): GatewayStatus {
    return this.currentStatus;
  }
}
