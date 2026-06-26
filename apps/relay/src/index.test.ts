import { generateKeyPairSync } from 'node:crypto';
import {
  type AssertionClaims,
  type DialTokenClaims,
  decodeDialTokenClaims,
  signAssertion,
  signDialToken,
  verifyAssertion,
  verifyDialToken,
} from './index.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const cnf = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString(
  'base64url',
);

test('re-exports the dial-token + cnf surface', () => {
  const claims: DialTokenClaims = { tenantId: 't1', gatewayId: 'gw-1', cnf, exp: 2_000_000_000 };
  const tok = signDialToken(claims, privateKey);
  expect(verifyDialToken(tok, publicKey, 1_000_000_000)?.cnf).toBe(cnf);
  expect(decodeDialTokenClaims(tok)?.cnf).toBe(cnf);
});

test('re-exports the assertion surface (KeyObject + raw cnf string)', () => {
  const claims: AssertionClaims = {
    gatewayId: 'gw-1',
    aud: 'relay-dial',
    iat: 1_000_000_000,
    exp: 1_000_000_060,
  };
  const tok = signAssertion(claims, privateKey);
  expect(verifyAssertion(tok, publicKey, 1_000_000_030, 'relay-dial')).toEqual(claims);
  expect(verifyAssertion(tok, cnf, 1_000_000_030, 'relay-dial')).toEqual(claims);
});
