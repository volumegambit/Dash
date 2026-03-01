import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('throws on wrong auth token', async () => {
    const badClient = new ManagementClient(`http://localhost:${port}`, 'wrong-token');
    await expect(badClient.health()).rejects.toThrow('Management API error 401');
  });

  it('throws on non-200 responses', async () => {
    const badClient = new ManagementClient(`http://localhost:${port}`, 'wrong-token');
    await expect(badClient.info()).rejects.toThrow('Management API error 401');
  });
});
