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
  pool?: { size: number; maxSize: number; pinned: number; agents: Record<string, number> };
  runtimeAgents?: number;
  mcpServers?: Array<{ name: string; status: string }>;
}

export interface RuntimeAgentConfig {
  name: string;
  model: string;
  systemPrompt: string;
  fallbackModels?: string[];
  tools?: string[];
  skills?: { paths?: string[]; urls?: string[] };
  workspace?: string;
  maxTokens?: number;
  mcpServers?: string[];
  providerApiKeys?: Record<string, string>;
}

export interface RegisteredRuntimeAgent {
  name: string;
  config: RuntimeAgentConfig;
  status: 'registered' | 'active' | 'disabled';
  registeredAt: number;
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

  async registerRuntimeAgent(config: RuntimeAgentConfig): Promise<void> {
    const res = await fetch(`${this.baseUrl}/runtime/agents`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway registerRuntimeAgent failed: ${res.status} ${body}`);
    }
  }

  async listRuntimeAgents(): Promise<RegisteredRuntimeAgent[]> {
    const res = await fetch(`${this.baseUrl}/runtime/agents`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Gateway listRuntimeAgents failed: ${res.status}`);
    }
    return res.json() as Promise<RegisteredRuntimeAgent[]>;
  }

  async getRuntimeAgent(name: string): Promise<RegisteredRuntimeAgent> {
    const res = await fetch(`${this.baseUrl}/runtime/agents/${encodeURIComponent(name)}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Gateway getRuntimeAgent failed: ${res.status}`);
    }
    return res.json() as Promise<RegisteredRuntimeAgent>;
  }

  async updateRuntimeAgent(name: string, patch: Partial<RuntimeAgentConfig>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/runtime/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      throw new Error(`Gateway updateRuntimeAgent failed: ${res.status}`);
    }
  }

  async removeRuntimeAgent(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/runtime/agents/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Gateway removeRuntimeAgent failed: ${res.status}`);
    }
  }

  async setRuntimeAgentCredentials(
    name: string,
    providerApiKeys: Record<string, string>,
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/runtime/agents/${encodeURIComponent(name)}/credentials`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ providerApiKeys }),
      },
    );
    if (!res.ok) {
      throw new Error(`Gateway setRuntimeAgentCredentials failed: ${res.status}`);
    }
  }

  async disableRuntimeAgent(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/runtime/agents/${encodeURIComponent(name)}/disable`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Gateway disableRuntimeAgent failed: ${res.status}`);
    }
  }

  async enableRuntimeAgent(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/runtime/agents/${encodeURIComponent(name)}/enable`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Gateway enableRuntimeAgent failed: ${res.status}`);
    }
  }
}
