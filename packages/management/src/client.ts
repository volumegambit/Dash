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
}
