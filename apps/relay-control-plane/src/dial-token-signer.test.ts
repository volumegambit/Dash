import { generateKeyPairSync } from 'node:crypto';
import { verifyDialToken } from '@dash/relay';
import { DialTokenSigner } from './dial-token-signer.js';

describe('DialTokenSigner', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  it('signs a token the relay verifier accepts, with tenantId/gatewayId/exp/cnf', () => {
    const signer = new DialTokenSigner(privateKey, 3600, () => 1000);
    const token = signer.signFor('t1', 'gw-1', 'pk-gw-1');

    // Round-trip: control-plane signFor(...) -> @dash/relay verifyDialToken(...).
    const claims = verifyDialToken(token, publicKey, 1000);
    expect(claims).toEqual({ tenantId: 't1', gatewayId: 'gw-1', exp: 4600, cnf: 'pk-gw-1' });
  });

  it('produces a token that the relay rejects once past expiry', () => {
    const signer = new DialTokenSigner(privateKey, 3600, () => 1000);
    const token = signer.signFor('t1', 'gw-1', 'pk-gw-1');

    expect(verifyDialToken(token, publicKey, 5000)).toBeNull();
  });

  it('defaults now() to Date.now() seconds when not injected', () => {
    const signer = new DialTokenSigner(privateKey, 3600);
    const token = signer.signFor('tenant', 'gw-now', 'pk-now');

    const nowSec = Math.floor(Date.now() / 1000);
    const claims = verifyDialToken(token, publicKey, nowSec);
    expect(claims?.tenantId).toBe('tenant');
    expect(claims?.gatewayId).toBe('gw-now');
    expect(claims?.cnf).toBe('pk-now');
    expect(claims?.exp).toBeGreaterThan(nowSec);
  });
});
