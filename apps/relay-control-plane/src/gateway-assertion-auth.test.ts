import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { signAssertion, verifyDialToken } from '@dash/relay';
import { DialTokenSigner } from './dial-token-signer.js';
import { GatewayAssertionAuthenticator } from './gateway-assertion-auth.js';
import { SqliteStore } from './store.js';

// CP dial-token signing key (the relay would verify with cpPublic).
const cp = generateKeyPairSync('ed25519');
const cpPublic = cp.publicKey;

// The gateway's own identity keypair. Its raw public key (base64url JWK `x`,
// ~43 chars) is stored at enrollment and is the cnf the CP binds tokens to.
const gw = generateKeyPairSync('ed25519');
const gwPubB64 = (gw.publicKey.export({ format: 'jwk' }) as { x: string }).x;

const NOW = 1000;

function setup() {
  const store = new SqliteStore(':memory:');
  store.createAccount('acct-1');
  store.createGateway({
    gatewayId: 'alice-mbp',
    accountId: 'acct-1',
    subdomain: 'alice-mbp.relay.example.com',
    publicKey: gwPubB64,
  });
  const signer = new DialTokenSigner(cp.privateKey, 3600, () => NOW);
  const auth = new GatewayAssertionAuthenticator({
    store,
    signer,
    verifyPublicKey: (b64) =>
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64 }, format: 'jwk' }),
    now: () => NOW,
  });
  return { store, auth };
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

describe('GatewayAssertionAuthenticator.mintDialToken', () => {
  it('mints a token bound to the STORED account + pubkey for a valid assertion', () => {
    const { auth } = setup();
    const assertion = signAssertion(
      { gatewayId: 'alice-mbp', aud: 'cp-dial-token', iat: NOW, exp: NOW + 60 },
      gw.privateKey,
    );

    const token = auth.mintDialToken(bearer(assertion));
    expect(token).not.toBeNull();
    const claims = verifyDialToken(token as string, cpPublic, NOW);
    expect(claims).toEqual({
      tenantId: 'acct-1',
      gatewayId: 'alice-mbp',
      exp: NOW + 3600,
      cnf: gwPubB64,
    });
  });

  it('re-derives tenantId from the store, ignoring the assertion entirely', () => {
    // The assertion carries no tenant; even a gateway that knew another account
    // cannot influence the minted tenantId — it comes from the stored record.
    const { auth } = setup();
    const assertion = signAssertion(
      { gatewayId: 'alice-mbp', aud: 'cp-dial-token', iat: NOW, exp: NOW + 60 },
      gw.privateKey,
    );
    const claims = verifyDialToken(auth.mintDialToken(bearer(assertion)) as string, cpPublic, NOW);
    expect(claims?.tenantId).toBe('acct-1');
  });

  it('returns null for a missing/garbage Authorization header', () => {
    const { auth } = setup();
    expect(auth.mintDialToken(undefined)).toBeNull();
    expect(auth.mintDialToken('not-bearer')).toBeNull();
    expect(auth.mintDialToken('Bearer not.a.token')).toBeNull();
  });

  it('returns null for an expired assertion', () => {
    const { auth } = setup();
    const assertion = signAssertion(
      { gatewayId: 'alice-mbp', aud: 'cp-dial-token', iat: NOW - 120, exp: NOW - 60 },
      gw.privateKey,
    );
    expect(auth.mintDialToken(bearer(assertion))).toBeNull();
  });

  it('returns null for an assertion signed by the wrong key', () => {
    const { auth } = setup();
    const impostor = generateKeyPairSync('ed25519').privateKey;
    const assertion = signAssertion(
      { gatewayId: 'alice-mbp', aud: 'cp-dial-token', iat: NOW, exp: NOW + 60 },
      impostor,
    );
    expect(auth.mintDialToken(bearer(assertion))).toBeNull();
  });

  it('returns null for the wrong audience (a relay-dial proof reused here)', () => {
    const { auth } = setup();
    const assertion = signAssertion(
      { gatewayId: 'alice-mbp', aud: 'relay-dial', iat: NOW, exp: NOW + 60 },
      gw.privateKey,
    );
    expect(auth.mintDialToken(bearer(assertion))).toBeNull();
  });

  it('returns null for an unknown gateway', () => {
    const { auth } = setup();
    const assertion = signAssertion(
      { gatewayId: 'ghost', aud: 'cp-dial-token', iat: NOW, exp: NOW + 60 },
      gw.privateKey,
    );
    expect(auth.mintDialToken(bearer(assertion))).toBeNull();
  });

  it('returns null for a revoked gateway', () => {
    const { store, auth } = setup();
    expect(store.revokeGateway('acct-1', 'alice-mbp')).toBe(true);
    const assertion = signAssertion(
      { gatewayId: 'alice-mbp', aud: 'cp-dial-token', iat: NOW, exp: NOW + 60 },
      gw.privateKey,
    );
    expect(auth.mintDialToken(bearer(assertion))).toBeNull();
  });
});
