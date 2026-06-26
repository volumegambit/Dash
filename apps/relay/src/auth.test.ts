import { generateKeyPairSync } from 'node:crypto';
import { hostedRelayAuth, staticRelayAuth } from './auth.js';
import { PairingCredentialStore } from './credential-store.js';
import { signDialToken } from './dial-token.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const cnf = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString(
  'base64url',
);

test('staticRelayAuth ignores gatewayId, compares the shared token', () => {
  const deps = staticRelayAuth('shared');
  expect(deps.relayTokenValid('gw-1', 'shared')).toBe(true);
  expect(deps.relayTokenValid('gw-2', 'wrong')).toBe(false);
});

test('hostedRelayAuth accepts a token whose claims.gatewayId matches the dialed gatewayId', () => {
  const store = new PairingCredentialStore();
  const deps = hostedRelayAuth({ publicKey, store, now: () => 1000 });
  const tok = signDialToken({ tenantId: 't1', gatewayId: 'gw-1', cnf, exp: 2000 }, privateKey);
  expect(deps.relayTokenValid('gw-1', tok)).toBe(true);
});

test('hostedRelayAuth REJECTS a valid token presented for a different gatewayId (spoofing)', () => {
  const store = new PairingCredentialStore();
  const deps = hostedRelayAuth({ publicKey, store, now: () => 1000 });
  const tok = signDialToken({ tenantId: 't1', gatewayId: 'gw-1', cnf, exp: 2000 }, privateKey);
  expect(deps.relayTokenValid('gw-2', tok)).toBe(false);
});
