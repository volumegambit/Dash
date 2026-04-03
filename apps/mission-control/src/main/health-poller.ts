import { ManagementClient } from '@dash/management';

export class HealthPoller {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastStatus = new Map<string, string>();
  private lastMcpStatuses = new Map<string, Map<string, string>>();
  private clients = new Map<string, ManagementClient>();

  start(
    id: string,
    managementPort: number,
    managementToken: string,
    onStatusChange: (status: string) => void,
    onMcpStatusChange?: (serverName: string, status: string) => void,
  ): void {
    this.stop(id); // stop any existing poller for this id
    const client = new ManagementClient(`http://127.0.0.1:${managementPort}`, managementToken);
    this.clients.set(id, client);
    const timer = setInterval(async () => {
      try {
        const result = await client.health();
        const status = result.status;
        const prev = this.lastStatus.get(id);
        if (status !== prev) {
          this.lastStatus.set(id, status);
          onStatusChange(status);
        }

        // Track MCP server statuses
        if (onMcpStatusChange && result.mcpServers) {
          let prevMcp = this.lastMcpStatuses.get(id);
          if (!prevMcp) {
            prevMcp = new Map();
            this.lastMcpStatuses.set(id, prevMcp);
          }
          for (const server of result.mcpServers) {
            const prevStatus = prevMcp.get(server.name);
            if (server.status !== prevStatus) {
              prevMcp.set(server.name, server.status);
              onMcpStatusChange(server.name, server.status);
            }
          }
        }
      } catch {
        const prev = this.lastStatus.get(id);
        if (prev !== 'error') {
          this.lastStatus.set(id, 'error');
          onStatusChange('error');
        }
      }
    }, 15_000);
    this.timers.set(id, timer);
  }

  stop(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
      this.lastStatus.delete(id);
      this.lastMcpStatuses.delete(id);
      this.clients.delete(id);
    }
  }

  stopAll(): void {
    for (const id of this.timers.keys()) {
      this.stop(id);
    }
  }
}
