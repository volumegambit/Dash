// apps/gateway/src/health-reporter.ts
import type { ChannelAdapter } from '@dash/channels';
import type { ChannelHealthEntry } from '@dash/management';
import { ManagementClient } from '@dash/management';

export class ChannelHealthReporter {
  private readonly client: ManagementClient;

  constructor(
    private readonly adapters: Array<{ adapter: ChannelAdapter; appId: string }>,
    managementUrl: string,
    managementToken: string,
  ) {
    this.client = new ManagementClient(managementUrl, managementToken);
  }

  start(): void {
    // Report current state immediately on startup
    this.report().catch(() => {}); // best-effort — agent-server may not be up yet

    // Re-report on every health change
    for (const { adapter } of this.adapters) {
      adapter.onHealthChange(() => this.report().catch(() => {}));
    }
  }

  private async report(): Promise<void> {
    const entries: ChannelHealthEntry[] = this.adapters.map(({ adapter, appId }) => ({
      appId,
      type: adapter.name,
      health: adapter.getHealth(),
    }));
    await this.client.postChannelHealth(entries);
  }
}
