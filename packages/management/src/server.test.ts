import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startManagementServer } from './server.js';
import type { InfoResponse, SkillsConfig } from './types.js';

const TEST_TOKEN = 'test-secret-token';

describe('Management Server', () => {
  let server: Server;
  let close: () => Promise<void>;
  let port: number;
  let onShutdown: ReturnType<typeof vi.fn>;
  const testInfo: InfoResponse = {
    agents: [{ name: 'default', model: 'claude-sonnet-4-20250514', tools: ['bash'] }],
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

  it('GET /health returns 200 with correct shape (no auth required)', async () => {
    // Health endpoint is public — no token needed
    const res = await fetch(url('/health'));
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

  it('returns 401 on protected endpoints with missing auth token', async () => {
    const res = await fetch(url('/info'));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 on protected endpoints with wrong auth token', async () => {
    const res = await fetch(url('/info'), {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(url('/unknown'), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  describe('skills endpoints', () => {
    let skillsServer: Server;
    let skillsClose: () => Promise<void>;
    let skillsPort: number;

    const baseSkill = {
      name: 'brainstorming',
      description: 'Explore ideas before building',
      location: '/tmp/skills/brainstorming/SKILL.md',
      editable: true,
    };
    let storedContent = '---\nname: brainstorming\n---\n\n# Brainstorm';
    let storedConfig: SkillsConfig = { paths: ['/tmp/skills'], urls: [] };

    beforeEach(async () => {
      storedContent = '---\nname: brainstorming\n---\n\n# Brainstorm';
      storedConfig = { paths: ['/tmp/skills'], urls: [] };

      const result = startManagementServer({
        port: 0,
        token: TEST_TOKEN,
        getInfo: () => testInfo,
        onShutdown: vi.fn().mockResolvedValue(undefined),
        skills: {
          list: async (_agentName) => [baseSkill],
          get: async (_agentName, skillName) => {
            if (skillName === 'brainstorming') return { ...baseSkill, content: storedContent };
            return null;
          },
          updateContent: async (_agentName, _skillName, content) => {
            storedContent = content;
          },
          create: async (_agentName, name, description, content) => ({
            name,
            description,
            content,
            location: `/tmp/skills/${name}/SKILL.md`,
            editable: true,
          }),
          getConfig: (_agentName) => storedConfig,
          updateConfig: async (_agentName, config) => {
            storedConfig = config;
          },
        },
      });

      await new Promise<void>((resolve) => {
        if (result.server.listening) resolve();
        else result.server.once('listening', resolve);
      });
      const addr = result.server.address();
      skillsPort = typeof addr === 'object' && addr ? addr.port : 0;
      skillsServer = result.server;
      skillsClose = result.close;
    });

    afterEach(async () => {
      await skillsClose();
    });

    function skillsUrl(path: string) {
      return `http://localhost:${skillsPort}${path}`;
    }

    it('GET /agents/default/skills returns 200 with array of skills', async () => {
      const res = await fetch(skillsUrl('/agents/default/skills'), { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string }[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('brainstorming');
    });

    it('GET /agents/default/skills/brainstorming returns 200 with content', async () => {
      const res = await fetch(skillsUrl('/agents/default/skills/brainstorming'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { content: string };
      expect(body.content).toContain('Brainstorm');
    });

    it('GET /agents/default/skills/missing returns 404', async () => {
      const res = await fetch(skillsUrl('/agents/default/skills/missing'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it('PUT /agents/default/skills/brainstorming updates content and returns 200', async () => {
      const res = await fetch(skillsUrl('/agents/default/skills/brainstorming'), {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'new content' }),
      });
      expect(res.status).toBe(200);
      expect(storedContent).toBe('new content');
    });

    it('POST /agents/default/skills creates skill and returns 201', async () => {
      const res = await fetch(skillsUrl('/agents/default/skills'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-skill', description: 'A new skill', content: 'content' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe('new-skill');
    });

    it('GET /agents/default/skills/config returns 200 with paths', async () => {
      const res = await fetch(skillsUrl('/agents/default/skills/config'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SkillsConfig;
      expect(body.paths).toContain('/tmp/skills');
    });

    it('PATCH /agents/default/skills/config updates config and returns requiresRestart', async () => {
      const res = await fetch(skillsUrl('/agents/default/skills/config'), {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['/new/path'], urls: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { requiresRestart: boolean };
      expect(body.requiresRestart).toBe(true);
      expect(storedConfig.paths).toContain('/new/path');
    });

    it('skills routes return 501 when skills not configured', async () => {
      const res = await fetch(`http://localhost:${port}/agents/default/skills`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(501);
    });
  });

  describe('log endpoints', () => {
    let logDir: string;
    let logClose: () => Promise<void>;
    let logPort: number;

    beforeEach(async () => {
      logDir = await mkdtemp(join(tmpdir(), 'mgmt-logs-'));
      const logLines =
        '2026-03-07T10:00:00.000Z [info] Agent started\n2026-03-07T10:00:01.000Z [info] Processing message\n2026-03-07T10:00:02.000Z [warn] Slow response\n2026-03-07T10:00:03.000Z [info] Message complete\n2026-03-07T10:00:04.000Z [error] Connection lost\n';
      await writeFile(join(logDir, 'agent.log'), logLines);

      const result = startManagementServer({
        port: 0,
        token: TEST_TOKEN,
        getInfo: () => testInfo,
        onShutdown: vi.fn().mockResolvedValue(undefined),
        logFilePath: join(logDir, 'agent.log'),
      });
      await new Promise<void>((resolve) => {
        if (result.server.listening) resolve();
        else result.server.once('listening', resolve);
      });
      const addr = result.server.address();
      logPort = typeof addr === 'object' && addr ? addr.port : 0;
      logClose = result.close;
    });

    afterEach(async () => {
      await logClose();
      await rm(logDir, { recursive: true });
    });

    function logUrl(path: string) {
      return `http://localhost:${logPort}${path}`;
    }

    it('GET /logs returns last N lines with tail param', async () => {
      const res = await fetch(logUrl('/logs?tail=2'), { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lines: string[] };
      expect(body.lines).toHaveLength(2);
      expect(body.lines[0]).toContain('Message complete');
      expect(body.lines[1]).toContain('Connection lost');
    });

    it('GET /logs defaults to last 100 lines', async () => {
      const res = await fetch(logUrl('/logs'), { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lines: string[] };
      expect(body.lines).toHaveLength(5);
    });

    it('GET /logs with since filters by timestamp', async () => {
      const res = await fetch(logUrl('/logs?since=2026-03-07T10:00:02.000Z'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lines: string[] };
      expect(body.lines).toHaveLength(3);
      expect(body.lines[0]).toContain('Slow response');
    });

    it('GET /logs returns 404 when no log file configured', async () => {
      // Use the default server (no logFilePath) via the outer port variable
      const res = await fetch(`http://localhost:${port}/logs`, { headers: authHeaders() });
      expect(res.status).toBe(404);
    });

    it('GET /logs/stream returns SSE content type', async () => {
      const controller = new AbortController();
      const res = await fetch(logUrl('/logs/stream'), {
        headers: authHeaders(),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();
    });
  });
});
