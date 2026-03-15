import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagementClient } from './client.js';
import { startManagementServer } from './server.js';
import type { InfoResponse } from './types.js';

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
