import type {
  ChannelHealthEntry,
  HealthResponse,
  InfoResponse,
  ShutdownResponse,
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
}
