import type { HealthResponse, InfoResponse, ShutdownResponse } from './types.js';

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

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  async info(): Promise<InfoResponse> {
    return this.request<InfoResponse>('GET', '/info');
  }

  async shutdown(): Promise<ShutdownResponse> {
    return this.request<ShutdownResponse>('POST', '/lifecycle/shutdown');
  }

  async logs(opts?: { tail?: number; since?: string }): Promise<string[]> {
    const params = new URLSearchParams();
    if (opts?.tail !== undefined) params.set('tail', String(opts.tail));
    if (opts?.since) params.set('since', opts.since);
    const query = params.toString();
    const path = query ? `/logs?${query}` : '/logs';
    const result = await this.request<{ lines: string[] }>('GET', path);
    return result.lines;
  }

  async *streamLogs(signal?: AbortSignal): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/logs/stream`, {
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
