import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startManagementServer } from './server.js';
import type { InfoResponse } from './types.js';

const TEST_TOKEN = 'test-secret-token';

describe('Management Server', () => {
  let server: Server;
  let close: () => Promise<void>;
  let port: number;
  let onShutdown: ReturnType<typeof vi.fn>;
  const testInfo: InfoResponse = {
    agents: [{ name: 'default', model: 'claude-sonnet-4-20250514', tools: ['bash'] }],
    channels: [{ name: 'telegram', agent: 'default' }],
  };

  beforeEach(async () => {
    onShutdown = vi.fn().mockResolvedValue(undefined);
    const result = startManagementServer({
      port: 0,
      token: TEST_TOKEN,
      getInfo: () => testInfo,
      onShutdown,
    });
    server = result.server;
    close = result.close;

    // Wait for server to be listening and get assigned port
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.once('listening', resolve);
      }
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await close();
  });

  function url(path: string): string {
    return `http://localhost:${port}${path}`;
  }

  function authHeaders(): HeadersInit {
    return { Authorization: `Bearer ${TEST_TOKEN}` };
  }

  it('GET /health returns 200 with correct shape', async () => {
    const res = await fetch(url('/health'), { headers: authHeaders() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
  });

  it('GET /info returns 200 with agents and channels', async () => {
    const res = await fetch(url('/info'), { headers: authHeaders() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual(testInfo);
  });

  it('POST /lifecycle/shutdown returns 200 and calls onShutdown', async () => {
    const res = await fetch(url('/lifecycle/shutdown'), {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(onShutdown).toHaveBeenCalledOnce();
  });

  it('returns 401 with missing auth token', async () => {
    const res = await fetch(url('/health'));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 with wrong auth token', async () => {
    const res = await fetch(url('/health'), {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(url('/unknown'), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});
