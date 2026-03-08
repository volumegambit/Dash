import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagementClient } from './client.js';
import { startManagementServer } from './server.js';
import type { InfoResponse, SkillContent, SkillInfo, SkillsConfig } from './types.js';

const TEST_TOKEN = 'client-test-token';

describe('ManagementClient', () => {
  let server: Server;
  let close: () => Promise<void>;
  let port: number;
  let client: ManagementClient;

  const testInfo: InfoResponse = {
    agents: [
      { name: 'assistant', model: 'claude-sonnet-4-20250514', tools: ['bash', 'read_file'] },
    ],
  };

  beforeEach(async () => {
    const result = startManagementServer({
      port: 0,
      token: TEST_TOKEN,
      getInfo: () => testInfo,
      onShutdown: async () => {},
    });
    server = result.server;
    close = result.close;

    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.once('listening', resolve);
      }
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    client = new ManagementClient(`http://localhost:${port}`, TEST_TOKEN);
  });

  afterEach(async () => {
    await close();
  });

  it('health() returns typed HealthResponse', async () => {
    const res = await client.health();
    expect(res.status).toBe('healthy');
    expect(typeof res.uptime).toBe('number');
    expect(typeof res.version).toBe('string');
  });

  it('info() returns typed InfoResponse', async () => {
    const res = await client.info();
    expect(res).toEqual(testInfo);
  });

  it('shutdown() returns typed ShutdownResponse', async () => {
    const res = await client.shutdown();
    expect(res).toEqual({ success: true });
  });

  it('sends auth token in Authorization header', async () => {
    // If token is correct, request succeeds
    const res = await client.health();
    expect(res.status).toBe('healthy');
  });

  it('throws on wrong auth token for protected endpoints', async () => {
    const badClient = new ManagementClient(`http://localhost:${port}`, 'wrong-token');
    await expect(badClient.info()).rejects.toThrow('Management API error 401');
  });

  it('throws on non-200 responses', async () => {
    const badClient = new ManagementClient(`http://localhost:${port}`, 'wrong-token');
    await expect(badClient.info()).rejects.toThrow('Management API error 401');
  });

  describe('skill methods', () => {
    let skillsClient: ManagementClient;
    let skillsClose: () => Promise<void>;

    const baseSkill: SkillInfo = {
      name: 'brainstorming',
      description: 'Explore ideas',
      location: '/tmp/skills/brainstorming/SKILL.md',
      editable: true,
    };
    const baseSkillContent: SkillContent = { ...baseSkill, content: '# Brainstorm' };
    let storedContent = '# Brainstorm';
    let storedConfig: SkillsConfig = { paths: ['/tmp/skills'], urls: [] };

    beforeEach(async () => {
      storedContent = '# Brainstorm';
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
      const skillsPort = typeof addr === 'object' && addr ? addr.port : 0;
      skillsClose = result.close;
      skillsClient = new ManagementClient(`http://localhost:${skillsPort}`, TEST_TOKEN);
    });

    afterEach(async () => {
      await skillsClose();
    });

    it('skills() returns SkillInfo[] from GET /agents/:agentName/skills', async () => {
      const result = await skillsClient.skills('default');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('brainstorming');
      expect(result[0].editable).toBe(true);
    });

    it('skill() returns SkillContent from GET /agents/:agentName/skills/:skillName', async () => {
      const result = await skillsClient.skill('default', 'brainstorming');
      expect(result.name).toBe('brainstorming');
      expect(result.content).toBe('# Brainstorm');
    });

    it('skill() throws when server returns 404', async () => {
      await expect(skillsClient.skill('default', 'missing')).rejects.toThrow(
        'Management API error 404',
      );
    });

    it('updateSkillContent() sends PUT with correct body', async () => {
      await skillsClient.updateSkillContent('default', 'brainstorming', 'updated content');
      expect(storedContent).toBe('updated content');
    });

    it('createSkill() sends POST and returns SkillContent', async () => {
      const result = await skillsClient.createSkill(
        'default',
        'new-skill',
        'A new skill',
        'skill content',
      );
      expect(result.name).toBe('new-skill');
      expect(result.description).toBe('A new skill');
      expect(result.content).toBe('skill content');
      expect(result.editable).toBe(true);
    });

    it('skillsConfig() returns SkillsConfig', async () => {
      const result = await skillsClient.skillsConfig('default');
      expect(result.paths).toContain('/tmp/skills');
      expect(Array.isArray(result.urls)).toBe(true);
    });

    it('updateSkillsConfig() sends PATCH and returns { requiresRestart: true }', async () => {
      const result = await skillsClient.updateSkillsConfig('default', {
        paths: ['/new/path'],
        urls: [],
      });
      expect(result.requiresRestart).toBe(true);
      expect(storedConfig.paths).toContain('/new/path');
    });
  });

  describe('log methods', () => {
    let logDir: string;
    let logClient: ManagementClient;
    let logClose: () => Promise<void>;
    let logPort: number;

    beforeEach(async () => {
      logDir = await mkdtemp(join(tmpdir(), 'client-logs-'));
      const logLines =
        '2026-03-07T10:00:00.000Z [info] Line one\n2026-03-07T10:00:01.000Z [info] Line two\n2026-03-07T10:00:02.000Z [info] Line three\n';
      await writeFile(join(logDir, 'agent.log'), logLines);

      const result = startManagementServer({
        port: 0,
        token: TEST_TOKEN,
        getInfo: () => testInfo,
        onShutdown: async () => {},
        logFilePath: join(logDir, 'agent.log'),
      });
      await new Promise<void>((resolve) => {
        if (result.server.listening) resolve();
        else result.server.once('listening', resolve);
      });
      const addr = result.server.address();
      logPort = typeof addr === 'object' && addr ? addr.port : 0;
      logClose = result.close;
      logClient = new ManagementClient(`http://localhost:${logPort}`, TEST_TOKEN);
    });

    afterEach(async () => {
      await logClose();
      await rm(logDir, { recursive: true });
    });

    it('logs() returns historical log lines', async () => {
      const lines = await logClient.logs();
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('Line one');
    });

    it('logs() respects tail option', async () => {
      const lines = await logClient.logs({ tail: 1 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Line three');
    });

    it('logs() respects since option', async () => {
      const lines = await logClient.logs({ since: '2026-03-07T10:00:01.000Z' });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Line two');
    });
  });
});
