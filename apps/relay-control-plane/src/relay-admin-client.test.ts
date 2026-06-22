import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type RelayServer,
  createRelayServer,
  hostedRelayAuth,
} from '@dash/relay';
import { RelayAdminClient } from './relay-admin-client.js';

// Stand up a REAL relay so the client is exercised against the genuine
// Bearer-gated /admin contract — dogfooding the same server the gateway uses.
const { publicKey } = generateKeyPairSync('ed25519');

let server: RelayServer;
let store: DurableCredentialStore;
let baseUrl: string;

beforeEach(async () => {
  store = new DurableCredentialStore(':memory:');
  server = createRelayServer(hostedRelayAuth({ publicKey, store }), {
    admin: { secret: 'master', store },
  });
  await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (server.httpServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await server.close();
});

test('provisionPairing returns a credential the relay validates', async () => {
  const client = new RelayAdminClient(baseUrl, 'master');
  const credential = await client.provisionPairing('t1', 'gw-1');
  expect(typeof credential).toBe('string');
  expect(credential.length).toBeGreaterThan(0);
  // The same store the relay's hot path reads must now accept the credential.
  expect(store.isValid('gw-1', credential)).toBe(true);
});

test('revokePairing invalidates a specific credential', async () => {
  const client = new RelayAdminClient(baseUrl, 'master');
  const credential = await client.provisionPairing('t1', 'gw-1');
  expect(store.isValid('gw-1', credential)).toBe(true);

  await client.revokePairing('t1', 'gw-1', credential);
  expect(store.isValid('gw-1', credential)).toBe(false);
});

test('revokePairing without a credential revokes all for the gateway', async () => {
  const client = new RelayAdminClient(baseUrl, 'master');
  const a = await client.provisionPairing('t1', 'gw-1');
  const b = await client.provisionPairing('t1', 'gw-1');

  await client.revokePairing('t1', 'gw-1');
  expect(store.isValid('gw-1', a)).toBe(false);
  expect(store.isValid('gw-1', b)).toBe(false);
});

test('revokeGateway resolves (force-close is a no-op when no socket is live)', async () => {
  const client = new RelayAdminClient(baseUrl, 'master');
  await expect(client.revokeGateway('t1', 'gw-1')).resolves.toBeUndefined();
});

test('a wrong admin secret is rejected (401 → throws)', async () => {
  const client = new RelayAdminClient(baseUrl, 'wrong-secret');
  await expect(client.provisionPairing('t1', 'gw-1')).rejects.toThrow();
});

test('revoke tolerates an absent credential (idempotent)', async () => {
  const client = new RelayAdminClient(baseUrl, 'master');
  // Revoking something never provisioned must not throw — the relay answers 200.
  await expect(client.revokePairing('t1', 'gw-ghost', 'nope')).resolves.toBeUndefined();
});
