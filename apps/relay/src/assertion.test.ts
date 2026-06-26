import { generateKeyPairSync } from 'node:crypto';
import { type AssertionClaims, signAssertion, verifyAssertion } from './assertion.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// Raw 32-byte Ed25519 public key, base64url — the form carried as the dial-token `cnf`.
const cnf = Buffer.from(
  publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
).toString('base64url');
const claims: AssertionClaims = {
  gatewayId: 'gw-abc',
  aud: 'relay-dial',
  iat: 1_000_000_000,
  exp: 1_000_000_060,
};

test('verifies a freshly signed, unexpired assertion with the right aud', () => {
  const tok = signAssertion(claims, privateKey);
  expect(verifyAssertion(tok, publicKey, 1_000_000_030, 'relay-dial')).toEqual(claims);
});

test('verifies with a raw base64url cnf string as the public key', () => {
  const tok = signAssertion(claims, privateKey);
  expect(verifyAssertion(tok, cnf, 1_000_000_030, 'relay-dial')).toEqual(claims);
});

test('rejects an expired assertion', () => {
  const tok = signAssertion(claims, privateKey);
  expect(verifyAssertion(tok, publicKey, 1_000_000_061, 'relay-dial')).toBeNull();
});

test('rejects when exp equals now (exp must be strictly in the future)', () => {
  const tok = signAssertion(claims, privateKey);
  expect(verifyAssertion(tok, publicKey, 1_000_000_060, 'relay-dial')).toBeNull();
});

test('rejects the wrong aud (namespacing the two uses)', () => {
  const tok = signAssertion(claims, privateKey);
  expect(verifyAssertion(tok, publicKey, 1_000_000_030, 'cp-dial-token')).toBeNull();
});

test('verifies the cp-dial-token aud when that is what is expected', () => {
  const cp: AssertionClaims = { ...claims, aud: 'cp-dial-token' };
  const tok = signAssertion(cp, privateKey);
  expect(verifyAssertion(tok, publicKey, 1_000_000_030, 'cp-dial-token')).toEqual(cp);
});

test('rejects an assertion signed by a different key', () => {
  const other = generateKeyPairSync('ed25519').privateKey;
  const tok = signAssertion(claims, other);
  expect(verifyAssertion(tok, publicKey, 1_000_000_030, 'relay-dial')).toBeNull();
});

test('rejects a raw cnf string that does not match the signer', () => {
  const otherCnf = Buffer.from(
    generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
  ).toString('base64url');
  const tok = signAssertion(claims, privateKey);
  expect(verifyAssertion(tok, otherCnf, 1_000_000_030, 'relay-dial')).toBeNull();
});

test('returns null (no throw) on an undecodable public-key string', () => {
  const tok = signAssertion(claims, privateKey);
  for (const bad of ['', 'not-a-key', 'AAAA']) {
    expect(verifyAssertion(tok, bad, 1_000_000_030, 'relay-dial')).toBeNull();
  }
});

test('rejects a tampered payload (sig no longer matches)', () => {
  const tok = signAssertion(claims, privateKey);
  const [, sig] = tok.split('.');
  const forged = Buffer.from(
    JSON.stringify({ ...claims, gatewayId: 'gw-evil' }),
  ).toString('base64url');
  expect(verifyAssertion(`${forged}.${sig}`, publicKey, 1_000_000_030, 'relay-dial')).toBeNull();
});

test('rejects malformed assertions without throwing', () => {
  for (const bad of ['', 'no-dot', 'a.b.c', '.', 'x.']) {
    expect(verifyAssertion(bad, publicKey, 1_000_000_030, 'relay-dial')).toBeNull();
  }
});
