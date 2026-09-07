import type {
  ConversationMessagePage,
  SubagentListEntry,
  SubagentListResponse,
} from '@dash/mobile-contract';
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
  PluginInstallResponse,
  PluginListResponse,
  PluginRecord,
  PluginSetStateRequest,
  Project,
  ProjectWithCounts,
  RuntimePluginsResponse,
  SessionIssueLink,
  ShutdownResponse,
  SkillContent,
  SkillInfo,
  SkillsConfig,
  SubagentResumeResult,
  SubagentStopResult,
  SwarmRunSnapshot,
  SwarmRunSummary,
  SwarmRunsResponse,
  SwarmWorkerActionResult,
} from './types.js';

export class ManagementClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private extraHeaders: Record<string, string> = {},
  ) {}

  private headers(contentType = false): Record<string, string> {
    return {
      ...this.extraHeaders,
      Authorization: `Bearer ${this.token}`,
      ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async request<T>(method: string, path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
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
      headers: this.headers(true),
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
      headers: this.headers(),
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

  async updateSkillsConfig(agentName: string, config: SkillsConfig): Promise<SkillsConfig> {
    return this.requestWithBody<SkillsConfig>(
      'PATCH',
      `/agents/${encodeURIComponent(agentName)}/skills/config`,
      config,
    );
  }

  async installSkill(agentId: string, source: string, name?: string): Promise<SkillInfo> {
    return this.requestWithBody<SkillInfo>(
      'POST',
      `/agents/${encodeURIComponent(agentId)}/skills/install`,
      { source, name },
    );
  }

  async removeSkill(agentId: string, skillName: string): Promise<void> {
    await this.request<{ name: string }>(
      'DELETE',
      `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillName)}`,
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
      headers: this.headers(),
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

  // --- Plugins ---

  async pluginsList(): Promise<PluginListResponse> {
    return this.request<PluginListResponse>('GET', '/plugins');
  }

  async pluginSetState(name: string, patch: PluginSetStateRequest): Promise<PluginRecord> {
    return this.requestWithBody<PluginRecord>('PUT', `/plugins/${encodeURIComponent(name)}`, patch);
  }

  async pluginInstall(source: string, name?: string): Promise<PluginInstallResponse> {
    return this.requestWithBody<PluginInstallResponse>('POST', '/plugins/install', {
      source,
      ...(name ? { name } : {}),
    });
  }

  async pluginRemove(name: string): Promise<{ ok: boolean; path?: string }> {
    return this.request<{ ok: boolean; path?: string }>(
      'DELETE',
      `/plugins/${encodeURIComponent(name)}`,
    );
  }

  async pluginReload(): Promise<{ ok: boolean; reloadedAt?: string }> {
    return this.request<{ ok: boolean; reloadedAt?: string }>('POST', '/plugins/reload');
  }

  async runtimePlugins(): Promise<RuntimePluginsResponse> {
    return this.request<RuntimePluginsResponse>('GET', '/runtime/plugins');
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

  async deleteIssue(id: string): Promise<void> {
    await this.requestDelete(`/issues/${encodeURIComponent(id)}`);
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

  async linkSession(
    issueId: string,
    sessionId: string,
    agentId?: string,
  ): Promise<SessionIssueLink> {
    return this.requestWithBody<SessionIssueLink>(
      'POST',
      `/issues/${encodeURIComponent(issueId)}/sessions`,
      { session_id: sessionId, agent_id: agentId ?? null },
    );
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

  // --- Swarm panel management ---

  /** List swarm runs (live + finalized history) for an agent. */
  async listSwarmRuns(agentId: string): Promise<SwarmRunSummary[]> {
    const result = await this.request<SwarmRunsResponse>(
      'GET',
      `/agents/${encodeURIComponent(agentId)}/swarm/runs`,
    );
    return result.runs;
  }

  /** Fetch the full snapshot (workers included) for one swarm run. */
  async getSwarmRun(agentId: string, runId: string): Promise<SwarmRunSnapshot> {
    return this.request<SwarmRunSnapshot>(
      'GET',
      `/agents/${encodeURIComponent(agentId)}/swarm/runs/${encodeURIComponent(runId)}`,
    );
  }

  /**
   * Cancel a swarm worker from the panel. The gateway returns 200 `{ok:true}`
   * on success and 409 `{ok:false, reason}` when the run is finalized or the
   * worker is already terminal. Because the panel needs the `reason` (not an
   * exception), this method catches the 409 specially and returns the parsed
   * `{ok:false, reason}` body. All other non-2xx responses propagate as the
   * usual `Management API error` throw.
   */
  async cancelSwarmWorker(
    agentId: string,
    runId: string,
    workerId: string,
  ): Promise<SwarmWorkerActionResult> {
    return this.requestWorkerAction(
      `/agents/${encodeURIComponent(agentId)}/swarm/runs/${encodeURIComponent(
        runId,
      )}/workers/${encodeURIComponent(workerId)}/cancel`,
      {},
    );
  }

  /**
   * Steer a swarm worker from the panel by sending it a message. Same
   * 409-handling contract as {@link cancelSwarmWorker}: 200 `{ok:true}` on
   * success; 409 `{ok:false, reason}` (run finalized / worker terminal) is
   * returned as the parsed body rather than thrown; other non-2xx responses
   * (e.g. 400 empty message, 404 unknown agent/run) propagate as the usual
   * `Management API error` throw.
   */
  async sendSwarmWorker(
    agentId: string,
    runId: string,
    workerId: string,
    message: string,
  ): Promise<SwarmWorkerActionResult> {
    return this.requestWorkerAction(
      `/agents/${encodeURIComponent(agentId)}/swarm/runs/${encodeURIComponent(
        runId,
      )}/workers/${encodeURIComponent(workerId)}/send`,
      { message },
    );
  }

  /**
   * POST a swarm worker action (cancel/send). Mirrors `requestWithBody` but
   * treats HTTP 409 as a valid `{ok:false, reason}` result rather than an
   * error, so the panel can surface the coordinator's reason string. Every
   * other non-2xx status throws the same `Management API error` as the shared
   * helpers. The 409 body is parsed defensively: a non-JSON body (e.g. a
   * reverse proxy or truncated response) falls back to `{ok:false, reason}`
   * carrying the raw text rather than throwing a `SyntaxError`.
   */
  private async requestWorkerAction(path: string, body: unknown): Promise<SwarmWorkerActionResult> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 409) {
      const text = await response.text();
      try {
        return JSON.parse(text) as SwarmWorkerActionResult;
      } catch {
        return { ok: false, reason: text.trim() || 'worker action failed (409)' };
      }
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Management API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<SwarmWorkerActionResult>;
  }

  // --- Sub-agent runtime (children of a conversation) ---
  //
  // The gateway mounts these on the loopback management app AND on
  // `/mobile/v1` (`mountSubagentRuntimeRoutes`), so this client and the phone
  // reach one implementation. Unlike the run-scoped swarm actions above they
  // answer with the typed `MobileApiError` envelope on every error path, so a
  // refusal's sentence has to be lifted out of `error` rather than read off an
  // `{ok:false, reason}` body the server never sends.

  /**
   * The conversation's children, newest state first-hand from the child rows.
   *
   * DEPTH-0 CHILDREN ONLY: a grandchild has no entry here, which is why a
   * client that folds sub-agent rows out of the transcript must keep that fold
   * as the fallback rather than replacing it with this list.
   */
  async listSubagents(conversationId: string): Promise<SubagentListEntry[]> {
    const result = await this.request<SubagentListResponse>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/subagents`,
    );
    return result.subagents;
  }

  /**
   * One page of a conversation's messages. Named for the route rather than for
   * sub-agents because that is all it is — but the caller this exists for is a
   * client expanding a child row, which needs the CHILD's transcript and has
   * no other way to ask for it.
   */
  async conversationMessages(
    conversationId: string,
    before?: string,
  ): Promise<ConversationMessagePage> {
    const query = before !== undefined ? `?${new URLSearchParams({ before }).toString()}` : '';
    return this.request<ConversationMessagePage>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    );
  }

  /**
   * Stop a child and every descendant. 409 (already terminal) comes back as
   * `{ok:false, reason}`; every other non-2xx throws.
   */
  async stopSubagent(subagentId: string): Promise<SubagentStopResult> {
    return this.requestSubagentAction<SubagentStopResult>(
      `/subagents/${encodeURIComponent(subagentId)}/stop`,
      undefined,
    );
  }

  /**
   * Send a message to a child from its parent — the ONLY client path to
   * `ChildHandle.answerQuestion`, and therefore the only one that enforces the
   * one-shot rule, the steer cap and the tool-grant rebuild. All three of those
   * refusals are 409s and arrive as `{ok:false, reason}`.
   *
   * `requestId` is echoed verbatim on the `accepted` frame of the turn this
   * message becomes — for a client that is subscribed to the child's stream.
   * It is sent regardless, because the correlation is the server's to offer and
   * a client that omits it can never gain the echo later.
   */
  async resumeSubagent(
    subagentId: string,
    message: string,
    requestId?: string,
  ): Promise<SubagentResumeResult> {
    return this.requestSubagentAction<SubagentResumeResult>(
      `/subagents/${encodeURIComponent(subagentId)}/resume`,
      { message, ...(requestId !== undefined ? { requestId } : {}) },
    );
  }

  /**
   * POST a sub-agent action, turning HTTP 409 into `{ok:false, reason}`.
   *
   * Only 409. A 400 is a malformed request this client built (blank message,
   * over-long correlation id) and a 404 is an id that names nothing — neither
   * is something to show a user as a refusal, and both should reach a
   * developer as the thrown `Management API error` every other method throws.
   *
   * The 409 body is the typed `MobileApiError` envelope, so the sentence is in
   * `error`. A non-JSON body (a proxy page, a truncated response) falls back to
   * the raw text rather than throwing a `SyntaxError` from the catch handler.
   */
  private async requestSubagentAction<T extends { ok: false; reason: string } | { ok: true }>(
    path: string,
    body: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 409) {
      const text = await response.text();
      let reason = text.trim();
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string' && parsed.error.length > 0) reason = parsed.error;
      } catch {
        // Non-JSON body: the raw text is the best sentence available.
      }
      return { ok: false, reason: reason || 'the sub-agent refused this action (409)' } as T;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Management API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }
}
