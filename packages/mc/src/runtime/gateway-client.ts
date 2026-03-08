export interface GatewayChannelRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentName: string;
  allowList: string[];
  denyList: string[];
}

export interface GatewayChannelConfig {
  adapter: 'telegram' | 'whatsapp';
  token?: string;
  authStateDir?: string;
  whatsappAuth?: Record<string, string>;
  globalDenyList?: string[];
  routing: GatewayChannelRoutingRule[];
}

export interface GatewayHealthResponse {
  status: string;
  startedAt: string;
  agents: number;
  channels: number;
}

export class GatewayManagementClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  async health(): Promise<GatewayHealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(3000),
    });
    return res.json() as Promise<GatewayHealthResponse>;
  }

  async registerAgent(
    deploymentId: string,
    agentName: string,
    chatUrl: string,
    chatToken: string,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ deploymentId, agentName, chatUrl, chatToken }),
    });
    if (!res.ok) {
      throw new Error(`Gateway registerAgent failed: ${res.status}`);
    }
  }

  async deregisterDeployment(deploymentId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/deployments/${deploymentId}`, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Best-effort: gateway may be down, swallow errors
    }
  }

  async registerChannel(
    deploymentId: string,
    channelName: string,
    config: GatewayChannelConfig,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/channels`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ deploymentId, channelName, config }),
    });
    if (!res.ok) {
      throw new Error(`Gateway registerChannel failed: ${res.status}`);
    }
  }
}
