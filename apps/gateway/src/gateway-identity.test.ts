import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAssertion } from '@dash/relay';
import { loadOrCreateGatewayIdentity } from './gateway-identity.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-identity-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gateway-identity', () => {
  it('generates a keypair on first boot and persists the private key 0600', async () => {
    const id = await loadOrCreateGatewayIdentity(dir);
    expect(id.publicKeyB64).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const st = await stat(join(dir, 'relay-gateway-key'));
    expect(st.mode & 0o777).toBe(0o600);
    const pem = await readFile(join(dir, 'relay-gateway-key'), 'utf8');
    expect(pem).toContain('PRIVATE KEY');
  });

  it('reuses the persisted key across reloads (stable pubkey)', async () => {
    const first = await loadOrCreateGatewayIdentity(dir);
    const second = await loadOrCreateGatewayIdentity(dir);
    expect(second.publicKeyB64).toBe(first.publicKeyB64);
  });

  it('signProof produces a relay-dial assertion that verifies against the pubkey', async () => {
    const now = () => 1_000_000;
    const id = await loadOrCreateGatewayIdentity(dir, now);
    const proof = id.signProof('gw-1');
    // verifyAssertion (P1) takes the raw base64url pubkey, checks sig + exp + aud.
    // This alone proves the proof was signed by this identity's private key, so
    // no createPublicKey reconstruction is needed here.
    const claims = verifyAssertion(proof, id.publicKeyB64, now(), 'relay-dial');
    expect(claims?.gatewayId).toBe('gw-1');
    expect(claims?.aud).toBe('relay-dial');
    // Wrong aud is rejected (relay-dial vs cp-dial-token namespacing).
    expect(verifyAssertion(proof, id.publicKeyB64, now(), 'cp-dial-token')).toBeNull();
  });

  it('signCpAssertion produces a cp-dial-token assertion that verifies', async () => {
    const now = () => 2_000_000;
    const id = await loadOrCreateGatewayIdentity(dir, now);
    const assertion = id.signCpAssertion('gw-1');
    const claims = verifyAssertion(assertion, id.publicKeyB64, now(), 'cp-dial-token');
    expect(claims?.aud).toBe('cp-dial-token');
    expect(claims?.exp).toBe(now() + 60);
  });
});
