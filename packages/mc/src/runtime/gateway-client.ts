export interface GatewayAgent {
  id: string;
  name: string;
  config: {
    model: string;
    systemPrompt: string;
    fallbackModels?: string[];
    tools?: string[];
    skills?: { paths?: string[]; urls?: string[] };
    workspace?: string;
    maxTokens?: number;
    mcpServers?: string[];
  };
  status: 'registered' | 'active' | 'disabled';
  registeredAt: string;
}

export interface GatewayChannel {
  name: string;
  adapter: 'telegram' | 'whatsapp';
  globalDenyList: string[];
  /**
   * Adapter-level allow-list (Telegram). When non-empty, the adapter itself
   * rejects messages from senders not on the list and sends an
   * "unauthorized" reply. Entries may be numeric IDs, bare usernames, or
   * `@username`. Distinct from rule-level `allowList`: adapter-level
   * filtering runs before routing, so blocked senders never touch the
   * agent pool or the routed audit path.
   */
  allowedUsers: string[];
  routing: Array<{
    condition:
      | { type: 'default' }
      | { type: 'sender'; ids: string[] }
      | { type: 'group'; ids: string[] };
    agentId: string;
    allowList: string[];
    denyList: string[];
  }>;
  registeredAt: string;
}

export interface CreateAgentRequest {
  name: string;
  model: string;
  systemPrompt: string;
  fallbackModels?: string[];
  tools?: string[];
  skills?: { paths?: string[]; urls?: string[] };
  workspace?: string;
  maxTokens?: number;
  mcpServers?: string[];
}

export interface GatewayHealthResponse {
  status: 'healthy';
  startedAt: string;
  agents: number;
  channels: number;
  mcpServers?: Array<{ name: string; status: string }>;
}

export class GatewayManagementClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  private async throwIfNotOk(res: Response, label: string): Promise<void> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gateway ${label} failed: ${res.status} ${body}`.trimEnd());
    }
  }

  // Health
  async health(): Promise<GatewayHealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json() as Promise<GatewayHealthResponse>;
  }

  // Agents
  async createAgent(config: CreateAgentRequest): Promise<GatewayAgent> {
    const res = await fetch(`${this.baseUrl}/agents`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(config),
    });
    await this.throwIfNotOk(res, 'createAgent');
    return res.json() as Promise<GatewayAgent>;
  }

  async listAgents(): Promise<GatewayAgent[]> {
    const res = await fetch(`${this.baseUrl}/agents`, {
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'listAgents');
    return res.json() as Promise<GatewayAgent[]>;
  }

  async getAgent(id: string): Promise<GatewayAgent> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'getAgent');
    return res.json() as Promise<GatewayAgent>;
  }

  async updateAgent(id: string, patch: Partial<CreateAgentRequest>): Promise<GatewayAgent> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(patch),
    });
    await this.throwIfNotOk(res, 'updateAgent');
    return res.json() as Promise<GatewayAgent>;
  }

  async removeAgent(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'removeAgent');
  }

  async disableAgent(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'disableAgent');
  }

  async enableAgent(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'enableAgent');
  }

  // Channels
  async registerChannel(config: {
    name: string;
    adapter: string;
    globalDenyList?: string[];
    allowedUsers?: string[];
    routing: GatewayChannel['routing'];
  }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/channels`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(config),
    });
    await this.throwIfNotOk(res, 'registerChannel');
  }

  async listChannels(): Promise<GatewayChannel[]> {
    const res = await fetch(`${this.baseUrl}/channels`, {
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'listChannels');
    return res.json() as Promise<GatewayChannel[]>;
  }

  async getChannel(name: string): Promise<GatewayChannel> {
    const res = await fetch(`${this.baseUrl}/channels/${encodeURIComponent(name)}`, {
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'getChannel');
    return res.json() as Promise<GatewayChannel>;
  }

  async updateChannel(
    name: string,
    patch: Partial<Pick<GatewayChannel, 'globalDenyList' | 'allowedUsers' | 'routing'>>,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/channels/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(patch),
    });
    await this.throwIfNotOk(res, 'updateChannel');
  }

  async removeChannel(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/channels/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'removeChannel');
  }

  // Credentials
  async setCredential(key: string, value: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/credentials`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ key, value }),
    });
    await this.throwIfNotOk(res, 'setCredential');
  }

  async listCredentials(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/credentials`, {
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'listCredentials');
    return res.json() as Promise<string[]>;
  }

  async removeCredential(key: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/credentials/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'removeCredential');
  }
}
