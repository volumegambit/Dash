import type {
  HealthResponse,
  InfoResponse,
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

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
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
}
