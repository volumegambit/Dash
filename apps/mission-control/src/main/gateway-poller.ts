import type { GatewayManagementClient } from '@dash/mc';

export type GatewayStatus = 'starting' | 'healthy' | 'unhealthy';

type EnsureGateway = () => Promise<GatewayManagementClient | null>;

export class GatewayPoller {
  private timer: NodeJS.Timeout | null = null;
  private currentStatus: GatewayStatus = 'starting';
  private lastMcpStatuses = new Map<string, string>();

  constructor(
    private ensureGateway: EnsureGateway,
    private intervalMs = 5_000,
  ) {}

  start(
    onStatusChange: (status: GatewayStatus) => void,
    onMcpStatusChange?: (serverName: string, status: string) => void,
  ): void {
    this.stop();
    this.timer = setInterval(async () => {
      try {
        const client = await this.ensureGateway();
        if (!client) return;
        const health = await client.health();
        const newStatus: GatewayStatus = health.status === 'healthy' ? 'healthy' : 'unhealthy';
        if (newStatus !== this.currentStatus) {
          this.currentStatus = newStatus;
          onStatusChange(newStatus);
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
        if (this.currentStatus !== 'unhealthy') {
          this.currentStatus = 'unhealthy';
          onStatusChange('unhealthy');
        }
      }
    }, this.intervalMs);
  }

  stop(): void {
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
