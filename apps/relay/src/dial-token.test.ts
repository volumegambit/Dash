import { generateKeyPairSync } from 'node:crypto';
import { type DialTokenClaims, signDialToken, verifyDialToken } from './dial-token.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const claims: DialTokenClaims = { tenantId: 't1', gatewayId: 'gw-abc', exp: 2_000_000_000 };

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
