import { generateKeyPairSync, sign } from 'node:crypto';
import { type DialTokenClaims, signDialToken, verifyDialToken } from './dial-token.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const cnf = Buffer.from(
  generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
).toString('base64url');
const claims: DialTokenClaims = { tenantId: 't1', gatewayId: 'gw-abc', cnf, exp: 2_000_000_000 };

test('verifies a freshly signed, unexpired token', () => {
  const tok = signDialToken(claims, privateKey);
  expect(verifyDialToken(tok, publicKey, 1_000_000_000)).toEqual(claims);
});

test('rejects an expired token', () => {
  const tok = signDialToken({ ...claims, exp: 1_000 }, privateKey);
  expect(verifyDialToken(tok, publicKey, 1_000_000_000)).toBeNull();
});

test('rejects a token signed by a different key', () => {
  const other = generateKeyPairSync('ed25519').privateKey;
  const tok = signDialToken(claims, other);
  expect(verifyDialToken(tok, publicKey, 1_000_000_000)).toBeNull();
});

test('rejects a tampered payload (sig no longer matches)', () => {
  const tok = signDialToken(claims, privateKey);
  const [, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, gatewayId: 'gw-evil' })).toString(
    'base64url',
  );
  expect(verifyDialToken(`${forged}.${sig}`, publicKey, 1_000_000_000)).toBeNull();
});

test('rejects malformed tokens without throwing', () => {
  for (const bad of ['', 'no-dot', 'a.b.c', '.', 'x.']) {
    expect(verifyDialToken(bad, publicKey, 1_000_000_000)).toBeNull();
  }
});

test('round-trips the cnf (holder-of-key public key) through sign/verify', () => {
  const tok = signDialToken(claims, privateKey);
  const out = verifyDialToken(tok, publicKey, 1_000_000_000);
  expect(out?.cnf).toBe(cnf);
});

test('rejects a token whose claims are missing cnf', () => {
  const noCnf = { tenantId: 't1', gatewayId: 'gw-abc', exp: 2_000_000_000 };
  const payload = Buffer.from(JSON.stringify(noCnf), 'utf8').toString('base64url');
  const sig = sign(null, Buffer.from(payload), privateKey).toString('base64url');
  expect(verifyDialToken(`${payload}.${sig}`, publicKey, 1_000_000_000)).toBeNull();
});
