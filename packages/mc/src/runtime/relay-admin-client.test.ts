import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRelayAdminClient } from './relay-admin-client.js';

// A minimal stand-in for the relay's /admin/* API.
let server: http.Server;
let baseUrl: string;
const seen: { auth?: string; path?: string; body?: unknown } = {};

beforeEach(async () => {
  seen.auth = undefined;
  seen.path = undefined;
  seen.body = undefined;
  server = http.createServer((req, res) => {
    seen.auth = req.headers.authorization;
    seen.path = req.url;
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      seen.body = raw ? JSON.parse(raw) : {};
      if (req.headers.authorization !== 'Bearer admin-secret') {
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (req.url === '/admin/pairings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ gatewayId: 'gw-1', credential: 'minted-cred' }));
        return;
      }
      if (req.url === '/admin/pairings/revoke') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('createRelayAdminClient', () => {
  it('provisions a credential with the admin Bearer', async () => {
    const client = createRelayAdminClient(baseUrl, 'admin-secret');
    const cred = await client.provisionCredential('gw-1');
    expect(cred).toBe('minted-cred');
    expect(seen.auth).toBe('Bearer admin-secret');
    expect(seen.path).toBe('/admin/pairings');
    expect(seen.body).toEqual({ gatewayId: 'gw-1' });
  });

  it('trims a trailing slash on the base URL', async () => {
    const client = createRelayAdminClient(`${baseUrl}/`, 'admin-secret');
    await client.provisionCredential('gw-1');
    expect(seen.path).toBe('/admin/pairings'); // not //admin/pairings
  });

  it('throws when the admin secret is rejected', async () => {
    const client = createRelayAdminClient(baseUrl, 'wrong');
    await expect(client.provisionCredential('gw-1')).rejects.toThrow(/provision failed.*401/);
  });

  it('revokes a credential', async () => {
    const client = createRelayAdminClient(baseUrl, 'admin-secret');
    await client.revokeCredential('gw-1', 'minted-cred');
    expect(seen.path).toBe('/admin/pairings/revoke');
    expect(seen.body).toEqual({ gatewayId: 'gw-1', credential: 'minted-cred' });
  });
});
