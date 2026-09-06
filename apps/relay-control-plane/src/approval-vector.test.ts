import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const unpad = (value: string) => Buffer.from(value, 'base64url');

test('approval vector is raw Ed25519 and cross-language stable', async () => {
  const vector = JSON.parse(
    await readFile('contracts/mobile/v1/security/approval-ed25519-v1.json', 'utf8'),
  );
  const message = Buffer.from(
    `${vector.approvalId}\n${vector.pairingId}\n${vector.decision}`,
    'utf8',
  );
  expect(message).toEqual(unpad(vector.messageUtf8Base64Url));

  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, unpad(vector.seedBase64Url)]),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = sign(null, message, privateKey);
  expect(signature).toHaveLength(64);
  expect(signature.toString('base64url')).toBe(vector.signatureBase64Url);

  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: vector.publicKeyBase64Url },
    format: 'jwk',
  });
  expect(verify(null, message, publicKey, signature)).toBe(true);
});
