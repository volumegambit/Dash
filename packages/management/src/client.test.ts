import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagementClient } from './client.js';
import { startManagementServer } from './server.js';
import type {
  InfoResponse,
  InstalledPlugin,
  PluginListResponse,
  PluginRecord,
  PluginSetStateRequest,
  SkillContent,
  SkillInfo,
  SkillsConfig,
} from './types.js';

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

    it('URL-encodes agentName with special characters', async () => {
      // The server routes match any decoded :agentName, so an agent name with spaces still resolves.
      // This smoke test verifies encodeURIComponent does not break valid requests — the method must
      // not throw and must return the skill list regardless of the agent name used.
      const result = await skillsClient.skills('my agent');
      expect(Array.isArray(result)).toBe(true);
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

  describe('Projects methods', () => {
    interface RecordedRequest {
      method: string;
      url: string;
      body: unknown;
    }

    let recording: RecordedRequest[];
    let nextResponse: unknown;
    let rawServer: Server;
    let projClose: () => Promise<void>;
    let projClient: ManagementClient;
    let projBaseUrl: string;

    beforeEach(async () => {
      recording = [];
      nextResponse = {};

      rawServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown;
          try {
            body = raw ? JSON.parse(raw) : undefined;
          } catch {
            body = raw;
          }
          recording.push({ method: req.method ?? '', url: req.url ?? '', body });
          if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(nextResponse));
        });
      });

      await new Promise<void>((resolve) => rawServer.listen(0, resolve));
      const addr = rawServer.address();
      const projPort = typeof addr === 'object' && addr ? addr.port : 0;
      projClose = () =>
        new Promise<void>((resolve, reject) =>
          rawServer.close((err) => (err ? reject(err) : resolve())),
        );
      projBaseUrl = `http://localhost:${projPort}`;
      projClient = new ManagementClient(projBaseUrl, TEST_TOKEN);
    });

    afterEach(async () => {
      await projClose();
    });

    it('listProjects() GETs /projects', async () => {
      nextResponse = [];
      await projClient.listProjects();
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/projects');
    });

    it('listProjects(status) appends a status querystring', async () => {
      nextResponse = [];
      await projClient.listProjects('active');
      expect(recording[0].url).toBe('/projects?status=active');
    });

    it('createProject() POSTs /projects with JSON body', async () => {
      nextResponse = { id: 'p1' };
      await projClient.createProject({ name: 'P', key: 'P' });
      expect(recording[0].method).toBe('POST');
      expect(recording[0].url).toBe('/projects');
      expect(recording[0].body).toEqual({ name: 'P', key: 'P' });
    });

    it('getProject() GETs /projects/:id', async () => {
      nextResponse = { id: 'p1' };
      await projClient.getProject('p1');
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/projects/p1');
    });

    it('patchProject() PATCHes /projects/:id', async () => {
      nextResponse = { id: 'p1' };
      await projClient.patchProject('p1', { name: 'X' });
      expect(recording[0].method).toBe('PATCH');
      expect(recording[0].url).toBe('/projects/p1');
      expect(recording[0].body).toEqual({ name: 'X' });
    });

    it('listProjectIssues() GETs /projects/:id/issues', async () => {
      nextResponse = [];
      await projClient.listProjectIssues('p1');
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/projects/p1/issues');
    });

    it('listIssues() with no filters GETs bare /issues', async () => {
      nextResponse = [];
      await projClient.listIssues();
      expect(recording[0].url).toBe('/issues');
    });

    it('listIssues(filters) builds a querystring including agents_involved', async () => {
      nextResponse = [];
      await projClient.listIssues({
        project_id: 'p1',
        status: 'todo',
        agents_involved: 'agent-9',
      });
      const url = new URL(`http://x${recording[0].url}`);
      expect(url.pathname).toBe('/issues');
      expect(url.searchParams.get('project_id')).toBe('p1');
      expect(url.searchParams.get('status')).toBe('todo');
      expect(url.searchParams.get('agents_involved')).toBe('agent-9');
    });

    it('listIssues() drops undefined/null/empty filter values', async () => {
      nextResponse = [];
      await projClient.listIssues({ project_id: 'p1', status: undefined });
      expect(recording[0].url).toBe('/issues?project_id=p1');
    });

    it('createIssue() POSTs /issues with JSON body', async () => {
      nextResponse = { id: 'i1' };
      await projClient.createIssue({ title: 'T' });
      expect(recording[0].method).toBe('POST');
      expect(recording[0].url).toBe('/issues');
      expect(recording[0].body).toEqual({ title: 'T' });
    });

    it('getIssue() GETs /issues/:id', async () => {
      nextResponse = { id: 'i1' };
      await projClient.getIssue('i1');
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/issues/i1');
    });

    it('patchIssue() PATCHes /issues/:id', async () => {
      nextResponse = { id: 'i1' };
      await projClient.patchIssue('i1', { status: 'done' });
      expect(recording[0].method).toBe('PATCH');
      expect(recording[0].url).toBe('/issues/i1');
      expect(recording[0].body).toEqual({ status: 'done' });
    });

    it('addComment() POSTs /issues/:id/comments with { body }', async () => {
      nextResponse = { id: 'c1' };
      await projClient.addComment('i1', 'hello');
      expect(recording[0].method).toBe('POST');
      expect(recording[0].url).toBe('/issues/i1/comments');
      expect(recording[0].body).toEqual({ body: 'hello' });
    });

    it('editComment() PATCHes /issues/:id/comments/:commentId', async () => {
      nextResponse = { id: 'c1' };
      await projClient.editComment('i1', 'c1', 'edited');
      expect(recording[0].method).toBe('PATCH');
      expect(recording[0].url).toBe('/issues/i1/comments/c1');
      expect(recording[0].body).toEqual({ body: 'edited' });
    });

    it('deleteComment() DELETEs /issues/:id/comments/:commentId', async () => {
      nextResponse = {};
      await projClient.deleteComment('i1', 'c1');
      expect(recording[0].method).toBe('DELETE');
      expect(recording[0].url).toBe('/issues/i1/comments/c1');
    });

    it('listInbox() GETs /inbox', async () => {
      nextResponse = [];
      await projClient.listInbox();
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/inbox');
    });

    it('markInboxRead() POSTs /inbox/:id/mark-read', async () => {
      nextResponse = { ok: true };
      await projClient.markInboxRead('i1');
      expect(recording[0].method).toBe('POST');
      expect(recording[0].url).toBe('/inbox/i1/mark-read');
    });

    it('getIssueEvents() GETs /issues/:id/events', async () => {
      nextResponse = [];
      await projClient.getIssueEvents('i1');
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/issues/i1/events');
    });

    it('getIssueSessions() GETs /issues/:id/sessions', async () => {
      nextResponse = [];
      await projClient.getIssueSessions('i1');
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/issues/i1/sessions');
    });

    it('URL-encodes ids with special characters', async () => {
      nextResponse = { id: 'i 1' };
      await projClient.getIssue('i 1');
      expect(recording[0].url).toBe('/issues/i%201');
    });

    it('deleteComment() throws on non-ok response', async () => {
      const bad = new ManagementClient(projBaseUrl, 'wrong-token');
      await expect(bad.deleteComment('i1', 'c1')).rejects.toThrow('Management API error 401');
    });
  });

  describe('Plugin methods', () => {
    interface RecordedRequest {
      method: string;
      url: string;
      body: unknown;
    }

    let recording: RecordedRequest[];
    let nextResponse: unknown;
    let nextStatus: number;
    let rawServer: Server;
    let pluginClose: () => Promise<void>;
    let pluginClient: ManagementClient;
    let pluginBaseUrl: string;

    beforeEach(async () => {
      recording = [];
      nextResponse = {};
      nextStatus = 200;

      rawServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown;
          try {
            body = raw ? JSON.parse(raw) : undefined;
          } catch {
            body = raw;
          }
          recording.push({ method: req.method ?? '', url: req.url ?? '', body });
          if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
          }
          res.statusCode = nextStatus;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(nextResponse));
        });
      });

      await new Promise<void>((resolve) => rawServer.listen(0, resolve));
      const addr = rawServer.address();
      const pluginPort = typeof addr === 'object' && addr ? addr.port : 0;
      pluginClose = () =>
        new Promise<void>((resolve, reject) =>
          rawServer.close((err) => (err ? reject(err) : resolve())),
        );
      pluginBaseUrl = `http://localhost:${pluginPort}`;
      pluginClient = new ManagementClient(pluginBaseUrl, TEST_TOKEN);
    });

    afterEach(async () => {
      await pluginClose();
    });

    const sampleRecord: PluginRecord = {
      name: 'acme',
      status: 'loaded',
      enabled: true,
      trusted: false,
      activated: ['skills'],
      noop: ['hooks'],
      version: '1.2.3',
      displayName: 'Acme',
      description: 'An acme plugin',
      source: 'git:acme/acme',
    };

    it('pluginsList() GETs /plugins and returns { records }', async () => {
      nextResponse = { records: [sampleRecord] } satisfies PluginListResponse;
      const res = await pluginClient.pluginsList();
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/plugins');
      expect(res.records).toHaveLength(1);
      expect(res.records[0]).toEqual(sampleRecord);
    });

    it('pluginSetState() PUTs /plugins/:name with the patch body', async () => {
      nextResponse = { ...sampleRecord, trusted: true } satisfies PluginRecord;
      const patch: PluginSetStateRequest = { trusted: true };
      const res = await pluginClient.pluginSetState('acme', patch);
      expect(recording[0].method).toBe('PUT');
      expect(recording[0].url).toBe('/plugins/acme');
      expect(recording[0].body).toEqual({ trusted: true });
      expect(res.trusted).toBe(true);
    });

    it('pluginSetState() URL-encodes the plugin name', async () => {
      nextResponse = sampleRecord;
      await pluginClient.pluginSetState('@scope/name', { enabled: false });
      expect(recording[0].url).toBe('/plugins/%40scope%2Fname');
      expect(recording[0].body).toEqual({ enabled: false });
    });

    it('pluginInstall() POSTs /plugins/install with { source } and parses the 201 InstalledPlugin', async () => {
      const installed: InstalledPlugin = {
        name: 'acme',
        version: '1.2.3',
        description: 'An acme plugin',
        location: '/data/plugins/acme',
        scanVerdict: 'safe',
        scanReasons: [],
        source: 'git:acme/acme',
      };
      nextResponse = installed;
      nextStatus = 201;
      const res = await pluginClient.pluginInstall('git:acme/acme');
      expect(recording[0].method).toBe('POST');
      expect(recording[0].url).toBe('/plugins/install');
      expect(recording[0].body).toEqual({ source: 'git:acme/acme' });
      expect(res).toEqual(installed);
    });

    it('pluginInstall() includes name when provided', async () => {
      nextResponse = {
        name: 'override',
        location: '/data/plugins/override',
        scanVerdict: 'safe',
        scanReasons: [],
        source: 'git:acme/acme',
      } satisfies InstalledPlugin;
      nextStatus = 201;
      await pluginClient.pluginInstall('git:acme/acme', 'override');
      expect(recording[0].body).toEqual({ source: 'git:acme/acme', name: 'override' });
    });

    it('pluginInstall() parses the reload-pending 200 body', async () => {
      const installed: InstalledPlugin = {
        name: 'acme',
        location: '/data/plugins/acme',
        scanVerdict: 'suspicious',
        scanReasons: ['network access'],
        source: 'git:acme/acme',
      };
      nextResponse = {
        ok: true,
        installed,
        note: 'installed and persisted; wiring reconciles on next reload',
        error: 'reload failed',
      };
      nextStatus = 200;
      const res = await pluginClient.pluginInstall('git:acme/acme');
      expect(recording[0].url).toBe('/plugins/install');
      // Reload-pending shape: discriminated by `ok`.
      expect('ok' in res && res.ok).toBe(true);
      if ('ok' in res) {
        expect(res.installed).toEqual(installed);
        expect(res.note).toContain('reconciles on next reload');
        expect(res.error).toBe('reload failed');
      }
    });

    it('pluginRemove() DELETEs /plugins/:name and returns { ok, path? }', async () => {
      nextResponse = { ok: true, path: '/data/plugins/acme' };
      const res = await pluginClient.pluginRemove('acme');
      expect(recording[0].method).toBe('DELETE');
      expect(recording[0].url).toBe('/plugins/acme');
      expect(res).toEqual({ ok: true, path: '/data/plugins/acme' });
    });

    it('pluginRemove() handles the no-path body', async () => {
      nextResponse = { ok: true };
      const res = await pluginClient.pluginRemove('acme');
      expect(res.ok).toBe(true);
      expect(res.path).toBeUndefined();
    });

    it('pluginReload() POSTs /plugins/reload and returns { ok, reloadedAt? }', async () => {
      nextResponse = { ok: true, reloadedAt: '2026-06-22T00:00:00.000Z' };
      const res = await pluginClient.pluginReload();
      expect(recording[0].method).toBe('POST');
      expect(recording[0].url).toBe('/plugins/reload');
      expect(res.ok).toBe(true);
      expect(res.reloadedAt).toBe('2026-06-22T00:00:00.000Z');
    });

    it('runtimePlugins() GETs /runtime/plugins and returns providers + plugins', async () => {
      nextResponse = {
        providers: [{ id: 'acme', label: 'Acme', credentialPrefix: 'ACME_' }],
        plugins: [{ name: 'acme', displayName: 'Acme', version: '1.2.3' }],
      };
      const res = await pluginClient.runtimePlugins();
      expect(recording[0].method).toBe('GET');
      expect(recording[0].url).toBe('/runtime/plugins');
      expect(res.providers[0]).toEqual({ id: 'acme', label: 'Acme', credentialPrefix: 'ACME_' });
      expect(res.plugins[0]).toEqual({ name: 'acme', displayName: 'Acme', version: '1.2.3' });
    });

    it('pluginsList() throws on non-ok response', async () => {
      const bad = new ManagementClient(pluginBaseUrl, 'wrong-token');
      await expect(bad.pluginsList()).rejects.toThrow('Management API error 401');
    });
  });
});
