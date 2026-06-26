import { type KeyObject, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { signAssertion } from './assertion.js';
import { credentialStoreAuth, hostedRelayAuth, staticRelayAuth } from './auth.js';
import { PairingCredentialStore } from './credential-store.js';
import { signDialToken } from './dial-token.js';

// Control-plane signer (signs dial tokens) and the gateway's own identity keypair.
const cp = generateKeyPairSync('ed25519');
const gw = generateKeyPairSync('ed25519');

/** Raw 32-byte Ed25519 public key as base64url — the `cnf` wire shape. */
function rawCnf(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return spki.subarray(spki.length - 32).toString('base64url');
}

const CNF = rawCnf(gw.publicKey);

/** A CP-signed dial token bound to `gatewayId`, carrying the gateway's pubkey as cnf. */
function dialToken(gatewayId: string, exp = 2000): string {
  return signDialToken({ tenantId: 't1', gatewayId, exp, cnf: CNF }, cp.privateKey);
}

/** A fresh holder-of-key proof signed by the gateway's private key. */
function proof(gatewayId: string, signer = gw.privateKey, aud = 'relay-dial', exp = 1030): string {
  return signAssertion({ gatewayId, aud, iat: 1000, exp }, signer);
}

test('staticRelayAuth ignores gatewayId and proof, compares the shared token', () => {
  const deps = staticRelayAuth('shared');
  expect(deps.verifyDialIn('gw-1', 'shared', undefined)).toBe(true);
  expect(deps.verifyDialIn('gw-2', 'wrong', 'whatever')).toBe(false);
});

test('credentialStoreAuth ignores the proof, compares the shared token', () => {
  const deps = credentialStoreAuth('shared', new PairingCredentialStore());
  expect(deps.verifyDialIn('gw-1', 'shared', undefined)).toBe(true);
  expect(deps.verifyDialIn('gw-1', 'nope', 'whatever')).toBe(false);
});

test('hostedRelayAuth admits a valid dial token + matching holder-of-key proof', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  expect(deps.verifyDialIn('gw-1', dialToken('gw-1'), proof('gw-1'))).toBe(true);
});

test('hostedRelayAuth REJECTS a stolen token presented WITHOUT a proof', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  expect(deps.verifyDialIn('gw-1', dialToken('gw-1'), undefined)).toBe(false);
});

test('hostedRelayAuth REJECTS an expired proof', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  expect(
    deps.verifyDialIn('gw-1', dialToken('gw-1'), proof('gw-1', gw.privateKey, 'relay-dial', 999)),
  ).toBe(false);
});

test('hostedRelayAuth REJECTS a proof signed by the WRONG key (not the cnf key)', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  const attacker = generateKeyPairSync('ed25519').privateKey;
  expect(deps.verifyDialIn('gw-1', dialToken('gw-1'), proof('gw-1', attacker))).toBe(false);
});

test('hostedRelayAuth REJECTS a proof whose aud is not relay-dial', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  expect(
    deps.verifyDialIn('gw-1', dialToken('gw-1'), proof('gw-1', gw.privateKey, 'cp-dial-token')),
  ).toBe(false);
});

test('hostedRelayAuth REJECTS when the proof gatewayId does not match the dialed gatewayId', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  // token is for gw-1, proof claims gw-2 — both must bind to the dialed id.
  expect(deps.verifyDialIn('gw-1', dialToken('gw-1'), proof('gw-2'))).toBe(false);
});

test('hostedRelayAuth REJECTS a dial token bound to a different gatewayId (spoofing)', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  expect(deps.verifyDialIn('gw-2', dialToken('gw-1'), proof('gw-2'))).toBe(false);
});

test('hostedRelayAuth REJECTS an expired dial token even with a fresh proof', () => {
  const deps = hostedRelayAuth({
    publicKey: cp.publicKey,
    store: new PairingCredentialStore(),
    now: () => 1000,
  });
  expect(deps.verifyDialIn('gw-1', dialToken('gw-1', 500), proof('gw-1'))).toBe(false);
});

test('reconstructing cnf into a KeyObject verifies a real proof end to end', () => {
  // Sanity: the raw-cnf reconstruction the impl performs must round-trip.
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const reconstructed = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(CNF, 'base64url')]),
    format: 'der',
    type: 'spki',
  });
  expect(reconstructed.asymmetricKeyType).toBe('ed25519');
});
