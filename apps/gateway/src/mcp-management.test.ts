import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpManager, McpServerConfig } from '@dash/mcp';
import { Hono } from 'hono';
import { mountMcpRoutes } from './mcp-management.js';
import { McpConfigStore } from './mcp-store.js';

function makeMockManager(): McpManager {
  return {
    getTools: vi.fn().mockReturnValue([]),
    getServerStatus: vi.fn().mockReturnValue('disconnected'),
    getFailedServers: vi.fn().mockReturnValue([]),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    addServer: vi.fn().mockResolvedValue(undefined),
    removeServer: vi.fn().mockResolvedValue(undefined),
  } as unknown as McpManager;
}

describe('MCP Management API', () => {
  let dir: string;
  let store: McpConfigStore;
  let manager: McpManager;
  let app: Hono;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-api-'));
    store = new McpConfigStore(dir);
    manager = makeMockManager();
    app = new Hono();
    mountMcpRoutes(app, { manager, configStore: store });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('POST /runtime/mcp/servers', () => {
    it('adds a server and returns 201', async () => {
      const body: McpServerConfig = {
        name: 'test',
        transport: { type: 'stdio', command: 'echo' },
      };
      const res = await app.request('/runtime/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { status: string; serverName: string };
      expect(json.status).toBe('connected');
      expect(json.serverName).toBe('test');
    });

    it('returns 400 for missing name', async () => {
      const res = await app.request('/runtime/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transport: { type: 'stdio', command: 'echo' } }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 403 when URL not in allowlist', async () => {
      await store.saveAllowlist(['https://trusted.com']);
      const body: McpServerConfig = {
        name: 'bad',
        transport: { type: 'sse', url: 'https://evil.com' },
      };
      const res = await app.request('/runtime/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    });

    it('returns 409 for duplicate name', async () => {
      (manager.addServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('already exists'),
      );
      const body: McpServerConfig = {
        name: 'dupe',
        transport: { type: 'stdio', command: 'echo' },
      };
      const res = await app.request('/runtime/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
    });
  });

  describe('GET /runtime/mcp/servers', () => {
    it('returns empty list initially', async () => {
      const res = await app.request('/runtime/mcp/servers');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual([]);
    });
  });

  describe('DELETE /runtime/mcp/servers/:name', () => {
    it('removes a server', async () => {
      await store.addConfig({
        name: 'removable',
        transport: { type: 'stdio', command: 'echo' },
      });
      const res = await app.request('/runtime/mcp/servers/removable', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect(manager.removeServer).toHaveBeenCalledWith('removable');
    });

    it('returns 404 for unknown server', async () => {
      (manager.removeServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('not found'),
      );
      const res = await app.request('/runtime/mcp/servers/ghost', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /runtime/mcp/servers/:name/reconnect', () => {
    it('returns 200 on successful reconnect', async () => {
      await store.addConfig({
        name: 'flaky',
        transport: { type: 'stdio', command: 'echo' },
      });
      const res = await app.request('/runtime/mcp/servers/flaky/reconnect', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    });

    it('returns 404 for unknown server', async () => {
      const res = await app.request('/runtime/mcp/servers/ghost/reconnect', {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('allowlist', () => {
    it('GET returns empty list by default', async () => {
      const res = await app.request('/runtime/mcp/allowlist');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('PUT sets the allowlist', async () => {
      const res = await app.request('/runtime/mcp/allowlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['https://trusted.com']),
      });
      expect(res.status).toBe(200);

      const getRes = await app.request('/runtime/mcp/allowlist');
      expect(await getRes.json()).toEqual(['https://trusted.com']);
    });
  });
});
