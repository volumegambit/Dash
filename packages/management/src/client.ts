import type {
  ChannelHealthEntry,
  CreateIssueInput,
  CreateProjectInput,
  HealthResponse,
  InboxItem,
  InfoResponse,
  Issue,
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueFilters,
  McpAddServerRequest,
  McpAddServerResponse,
  McpServerInfo,
  Project,
  ProjectWithCounts,
  SessionIssueLink,
  ShutdownResponse,
  SkillContent,
  SkillInfo,
  SkillsConfig,
} from './types.js';

export class ManagementClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(method: string, path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Management API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  private async requestWithBody<T>(method: string, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Management API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async requestDelete(path: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Management API error ${response.status}: ${body}`);
    }
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  async postChannelHealth(entries: ChannelHealthEntry[]): Promise<void> {
    await this.requestWithBody<{ ok: boolean }>('POST', '/channels/health', entries);
  }

  async getChannelHealth(): Promise<ChannelHealthEntry[]> {
    return this.request<ChannelHealthEntry[]>('GET', '/channels/health');
  }

  async info(): Promise<InfoResponse> {
    return this.request<InfoResponse>('GET', '/info');
  }

  async shutdown(): Promise<ShutdownResponse> {
    return this.request<ShutdownResponse>('POST', '/lifecycle/shutdown');
  }

  async logs(opts?: { tail?: number; since?: string; level?: 'info' | 'warn' | 'error' }): Promise<
    string[]
  > {
    const params = new URLSearchParams();
    if (opts?.tail !== undefined) params.set('tail', String(opts.tail));
    if (opts?.since) params.set('since', opts.since);
    if (opts?.level) params.set('level', opts.level);
    const query = params.toString();
    const path = query ? `/logs?${query}` : '/logs';
    const result = await this.request<{ lines: string[] }>('GET', path);
    return result.lines;
  }

  async skills(agentName: string): Promise<SkillInfo[]> {
    return this.request<SkillInfo[]>('GET', `/agents/${encodeURIComponent(agentName)}/skills`);
  }

  async skill(agentName: string, skillName: string): Promise<SkillContent> {
    return this.request<SkillContent>(
      'GET',
      `/agents/${encodeURIComponent(agentName)}/skills/${encodeURIComponent(skillName)}`,
    );
  }

  async updateSkillContent(agentName: string, skillName: string, content: string): Promise<void> {
    await this.requestWithBody<{ success: boolean }>(
      'PUT',
      `/agents/${encodeURIComponent(agentName)}/skills/${encodeURIComponent(skillName)}`,
      { content },
    );
  }

  async createSkill(
    agentName: string,
    skillName: string,
    description: string,
    content: string,
  ): Promise<SkillContent> {
    return this.requestWithBody<SkillContent>(
      'POST',
      `/agents/${encodeURIComponent(agentName)}/skills`,
      {
        name: skillName,
        description,
        content,
      },
    );
  }

  async skillsConfig(agentName: string): Promise<SkillsConfig> {
    return this.request<SkillsConfig>(
      'GET',
      `/agents/${encodeURIComponent(agentName)}/skills/config`,
    );
  }

  async updateSkillsConfig(
    agentName: string,
    config: SkillsConfig,
  ): Promise<{ requiresRestart: boolean }> {
    return this.requestWithBody<{ requiresRestart: boolean }>(
      'PATCH',
      `/agents/${encodeURIComponent(agentName)}/skills/config`,
      config,
    );
  }

  async updateCredentials(providerApiKeys: Record<string, Record<string, string>>): Promise<void> {
    await this.requestWithBody<{ success: boolean }>('POST', '/credentials', providerApiKeys);
  }

  async updateAgentConfig(
    agentName: string,
    patch: { model?: string; fallbackModels?: string[]; tools?: string[]; systemPrompt?: string },
  ): Promise<void> {
    await this.requestWithBody<{ success: boolean }>(
      'PATCH',
      `/agents/${encodeURIComponent(agentName)}/config`,
      patch,
    );
  }

  async *streamLogs(
    signal?: AbortSignal,
    opts?: { level?: 'info' | 'warn' | 'error' },
  ): AsyncGenerator<string> {
    const params = new URLSearchParams();
    if (opts?.level) params.set('level', opts.level);
    const query = params.toString();
    const response = await fetch(`${this.baseUrl}/logs/stream${query ? `?${query}` : ''}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Management API error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.startsWith('data: ')) {
            yield part.slice(6);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // --- MCP Connectors ---

  async mcpListServers(): Promise<McpServerInfo[]> {
    return this.request<McpServerInfo[]>('GET', '/runtime/mcp/servers');
  }

  async mcpGetServer(name: string): Promise<McpServerInfo> {
    return this.request<McpServerInfo>('GET', `/runtime/mcp/servers/${encodeURIComponent(name)}`);
  }

  async mcpAddServer(config: McpAddServerRequest): Promise<McpAddServerResponse> {
    return this.requestWithBody<McpAddServerResponse>('POST', '/runtime/mcp/servers', config);
  }

  async mcpRemoveServer(name: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      'DELETE',
      `/runtime/mcp/servers/${encodeURIComponent(name)}`,
    );
  }

  async mcpReconnectServer(name: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      'POST',
      `/runtime/mcp/servers/${encodeURIComponent(name)}/reconnect`,
    );
  }

  async mcpReauthorizeServer(name: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      'POST',
      `/runtime/mcp/servers/${encodeURIComponent(name)}/reauthorize`,
    );
  }

  async mcpGetAllowlist(): Promise<string[]> {
    return this.request<string[]>('GET', '/runtime/mcp/allowlist');
  }

  async mcpSetAllowlist(patterns: string[]): Promise<void> {
    await this.requestWithBody<{ ok: boolean }>('PUT', '/runtime/mcp/allowlist', patterns);
  }

  // --- Projects ---

  async listProjects(status?: Project['status']): Promise<Project[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request<Project[]>('GET', `/projects${qs}`);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.requestWithBody<Project>('POST', '/projects', input);
  }

  async getProject(id: string): Promise<ProjectWithCounts> {
    return this.request<ProjectWithCounts>('GET', `/projects/${encodeURIComponent(id)}`);
  }

  async patchProject(id: string, patch: Partial<Project>): Promise<Project> {
    return this.requestWithBody<Project>('PATCH', `/projects/${encodeURIComponent(id)}`, patch);
  }

  async listProjectIssues(id: string): Promise<Issue[]> {
    return this.request<Issue[]>('GET', `/projects/${encodeURIComponent(id)}/issues`);
  }

  // --- Issues ---

  async listIssues(filters: IssueFilters = {}): Promise<Issue[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    return this.request<Issue[]>('GET', `/issues${qs ? `?${qs}` : ''}`);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    return this.requestWithBody<Issue>('POST', '/issues', input);
  }

  async getIssue(id: string): Promise<IssueDetail> {
    return this.request<IssueDetail>('GET', `/issues/${encodeURIComponent(id)}`);
  }

  async patchIssue(id: string, patch: Partial<Issue>): Promise<Issue> {
    return this.requestWithBody<Issue>('PATCH', `/issues/${encodeURIComponent(id)}`, patch);
  }

  async addComment(issueId: string, body: string): Promise<IssueComment> {
    return this.requestWithBody<IssueComment>(
      'POST',
      `/issues/${encodeURIComponent(issueId)}/comments`,
      { body },
    );
  }

  async editComment(issueId: string, commentId: string, body: string): Promise<IssueComment> {
    return this.requestWithBody<IssueComment>(
      'PATCH',
      `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
      { body },
    );
  }

  async deleteComment(issueId: string, commentId: string): Promise<void> {
    await this.requestDelete(
      `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
    );
  }

  async getIssueEvents(id: string): Promise<IssueEvent[]> {
    return this.request<IssueEvent[]>('GET', `/issues/${encodeURIComponent(id)}/events`);
  }

  async getIssueSessions(id: string): Promise<SessionIssueLink[]> {
    return this.request<SessionIssueLink[]>('GET', `/issues/${encodeURIComponent(id)}/sessions`);
  }

  // --- Inbox ---

  async listInbox(): Promise<InboxItem[]> {
    return this.request<InboxItem[]>('GET', '/inbox');
  }

  async markInboxRead(issueId: string): Promise<void> {
    await this.requestWithBody<{ ok: boolean }>(
      'POST',
      `/inbox/${encodeURIComponent(issueId)}/mark-read`,
      {},
    );
  }
}
