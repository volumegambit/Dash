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

/**
 * Curated model returned by the gateway's `GET /models` endpoint. Same
 * shape as `@dash/models` `FilteredModel`. Re-declared locally to keep
 * the MC client zero-dependency on `@dash/models` — MC just consumes
 * the gateway's REST contract.
 */
export interface GatewayModel {
  value: string;
  label: string;
  provider: string;
}

/**
 * Response shape of `GET /models` and `POST /models/refresh`. The
 * `source` discriminates between live-fetched data and the curated
 * bootstrap fallback (returned when no provider credentials are
 * configured at all).
 */
export interface GatewayModelsResponse {
  models: GatewayModel[];
  source: 'live' | 'bootstrap';
  errors: Record<string, string>;
  fetchedAt: string;
  supportedModelsReviewedAt: string;
}

/**
 * Response shape of `GET /models?debug=true`. Adds the bootstrap list,
 * allow-list patterns, and configured/available provider lists for the
 * Under the Hood debug page.
 */
export interface GatewayModelsDebugResponse extends GatewayModelsResponse {
  bootstrap: GatewayModel[];
  patterns: Array<{ provider: string; pattern: string; tier: number }>;
  providersConfigured: string[];
  providersAvailable: string[];
}

export interface GatewayHealthResponse {
  status: 'healthy';
  startedAt: string;
  /**
   * OS process id of the gateway server. Load-bearing for MC's
   * `GatewaySupervisor`: when state.json drifts out of sync with the
   * actual port owner (crashes, orphaned detached children, PID reuse),
   * the supervisor reads this field from the live server instead of
   * trusting its own state file. Optional so older gateways can still
   * be detected (the supervisor falls back to `state.pid` + a
   * loud-warning code path in that case).
   */
  pid?: number;
  agents: number;
  channels: number;
  mcpServers?: Array<{ name: string; status: string }>;
}

/**
 * Structured HTTP error thrown by GatewayManagementClient when the server
 * returns a non-2xx response. Exposes the HTTP status so callers (notably
 * GatewaySupervisor) can distinguish transient failures from permanent
 * ones: a 401 means "our token is wrong, the gateway is unusable to us"
 * and should trigger a reconcile; a 500 or a fetch timeout means "the
 * gateway had a blip" and should just be retried.
 */
export class GatewayHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly label: string,
    public readonly body: string,
  ) {
    super(`Gateway ${label} failed: ${status} ${body}`.trimEnd());
    this.name = 'GatewayHttpError';
  }
}

/**
 * Default timeout for hot-path health/auth checks used by GatewaySupervisor.
 * Short enough that a blocked event loop in the gateway doesn't wedge MC's
 * startup / poller tick, long enough to survive normal GC pauses and MCP
 * tool roundtrips.
 */
const HOT_PATH_TIMEOUT_MS = 2_000;

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
      throw new GatewayHttpError(res.status, label, body);
    }
  }

  // Health — unauthenticated, short-timeout, used by supervisor hot path.
  async health(): Promise<GatewayHealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(HOT_PATH_TIMEOUT_MS),
    });
    await this.throwIfNotOk(res, 'health');
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
    // Short timeout: the supervisor's reuse-check calls this on every
    // `ensureRunning`, and an unbounded hang would wedge the poller.
    // User-action calls that care about longer latency can retry.
    const res = await fetch(`${this.baseUrl}/agents`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(HOT_PATH_TIMEOUT_MS),
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

  // Models — gateway is the single source of truth. The store survives
  // restarts; refresh forces a fetch from provider /v1/models endpoints.
  async listModels(): Promise<GatewayModelsResponse> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(HOT_PATH_TIMEOUT_MS),
    });
    await this.throwIfNotOk(res, 'listModels');
    return res.json() as Promise<GatewayModelsResponse>;
  }

  async refreshModels(): Promise<GatewayModelsResponse> {
    // No timeout: refresh hits provider /v1/models endpoints which can
    // take several seconds end-to-end. The route is mutex-guarded so
    // parallel callers share one fetch.
    const res = await fetch(`${this.baseUrl}/models/refresh`, {
      method: 'POST',
      headers: this.headers(),
    });
    await this.throwIfNotOk(res, 'refreshModels');
    return res.json() as Promise<GatewayModelsResponse>;
  }

  async debugModels(): Promise<GatewayModelsDebugResponse> {
    const res = await fetch(`${this.baseUrl}/models?debug=true`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(HOT_PATH_TIMEOUT_MS),
    });
    await this.throwIfNotOk(res, 'debugModels');
    return res.json() as Promise<GatewayModelsDebugResponse>;
  }
}
