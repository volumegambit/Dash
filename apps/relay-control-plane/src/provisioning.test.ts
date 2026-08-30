import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type RelayServer,
  createRelayServer,
  hostedRelayAuth,
  verifyDialToken,
} from '@dash/relay';
import { DialTokenSigner } from './dial-token-signer.js';
import {
  ApprovalClosedError,
  type CreatedPairing,
  InvalidApprovalSignatureError,
  InvalidPublicKeyError,
  type PendingApproval,
  ProvisioningService,
  WebChatTokenMissingError,
  approvalMessage,
} from './provisioning.js';
import { RelayAdminClient } from './relay-admin-client.js';
import { SqliteStore } from './store.js';

/** A fresh, canonical unpadded-base64url-encoded 32-byte Ed25519-shaped key. */
function freshSignerKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Narrow a mint result to the immediate-credential shape for tests that mint
 * on an account with no registered signers (or a mobile client) — those never
 * hit the Task 3 pending-approval branch, so an unexpected `PendingApproval`
 * here is a real test failure, not a type-only formality.
 */
function asActive(result: CreatedPairing | PendingApproval): CreatedPairing {
  if (result.status === 'pending') throw new Error('expected an immediate (non-pending) pairing');
  return result;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// A spy relay admin client — Task 6 only exercises gateway force-close, so we
// record calls without standing up a real relay (pairing routes land in Task 7).
function spyRelayClient() {
  const calls: { revokeGateway: Array<[string, string]> } = { revokeGateway: [] };
  const client = {
    revokeGateway: async (tenantId: string, gatewayId: string) => {
      calls.revokeGateway.push([tenantId, gatewayId]);
    },
  } as unknown as RelayAdminClient;
  return { client, calls };
}

function makeService(relay: RelayAdminClient, now: () => number = () => 1000) {
  const store = new SqliteStore(':memory:');
  const signer = new DialTokenSigner(privateKey, 3600, now);
  const service = new ProvisioningService({ store, signer, relay, relayZone: 'relay.example.com' });
  return { store, service };
}

describe('ProvisioningService.createGateway', () => {
  it('claims a label as the gatewayId, stores the pubkey, signs a cnf-bound token', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);

    const result = service.createGateway('acct-1', {
      subdomain: 'alice-mbp',
      publicKey: 'pk-alice',
    });

    expect(result.gatewayId).toBe('alice-mbp');
    expect(result.subdomain).toBe('alice-mbp.relay.example.com');

    // The dial token the relay would verify, bound to this gateway + pubkey.
    const claims = verifyDialToken(result.dialToken, publicKey, 1000);
    expect(claims).toEqual({
      tenantId: 'acct-1',
      gatewayId: 'alice-mbp',
      exp: 4600,
      cnf: 'pk-alice',
    });

    // The store persisted the gateway under the owning account, with the pubkey.
    const record = store.getGateway('alice-mbp');
    expect(record?.accountId).toBe('acct-1');
    expect(record?.publicKey).toBe('pk-alice');
    expect(record?.status).toBe('active');
  });

  it('rejects an invalid label without touching the store', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);

    expect(() =>
      service.createGateway('acct-1', { subdomain: 'Bad_Label', publicKey: 'pk' }),
    ).toThrow(/invalid subdomain/i);
    expect(store.getGateway('Bad_Label')).toBeNull();
  });

  it('rejects an empty public key', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    expect(() =>
      service.createGateway('acct-1', { subdomain: 'alice-mbp', publicKey: '' }),
    ).toThrow(/public key/i);
  });

  it('rejects a label already claimed (taken)', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    service.createGateway('acct-1', { subdomain: 'alice-mbp', publicKey: 'pk-1' });
    expect(() =>
      service.createGateway('acct-2', { subdomain: 'alice-mbp', publicKey: 'pk-2' }),
    ).toThrow(/taken/i);
  });

  it('never recycles a burned label: revoke then re-create is rejected', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);

    const gw = service.createGateway('acct-1', { subdomain: 'alice-mbp', publicKey: 'pk-1' });
    expect(store.revokeGateway('acct-1', gw.gatewayId)).toBe(true);

    expect(() =>
      service.createGateway('acct-1', { subdomain: 'alice-mbp', publicKey: 'pk-2' }),
    ).toThrow(/taken/i);
  });
});

describe('ProvisioningService.isSubdomainAvailable', () => {
  it('is true for an unused label and false once claimed', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    expect(service.isSubdomainAvailable('alice-mbp')).toBe(true);
    service.createGateway('acct-1', { subdomain: 'alice-mbp', publicKey: 'pk-1' });
    expect(service.isSubdomainAvailable('alice-mbp')).toBe(false);
  });

  it('is false for an invalid label (cannot be claimed anyway)', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);
    expect(service.isSubdomainAvailable('Bad_Label')).toBe(false);
  });
});

describe('ProvisioningService.listGateways', () => {
  it('returns only the calling account’s gateways', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    service.createGateway('acct-2', { subdomain: 'bob', publicKey: 'pk-b' });

    const list = service.listGateways('acct-1');
    expect(list.map((g) => g.gatewayId)).toEqual(['alice']);
  });
});

describe('ProvisioningService.deleteGateway', () => {
  it('refuses a wrong-owner delete: returns false, store untouched, no relay call', async () => {
    const { client, calls } = spyRelayClient();
    const { store, service } = makeService(client);

    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    const ok = await service.deleteGateway('acct-2', gw.gatewayId);
    expect(ok).toBe(false);
    // Record is untouched (still active under acct-1).
    expect(store.getGateway(gw.gatewayId)?.status).toBe('active');
    // The relay force-close MUST NOT fire for an unauthorized caller.
    expect(calls.revokeGateway).toEqual([]);
  });

  it('revokes in the store and force-closes on the relay for the owner', async () => {
    const { client, calls } = spyRelayClient();
    const { store, service } = makeService(client);

    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    const ok = await service.deleteGateway('acct-1', gw.gatewayId);
    expect(ok).toBe(true);
    expect(store.getGateway(gw.gatewayId)?.status).toBe('revoked');
    expect(calls.revokeGateway).toEqual([['acct-1', gw.gatewayId]]);
  });
});

describe('ProvisioningService.registerSigner', () => {
  it('registers a signer, minting an sg-<hex12> id', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);
    const key = freshSignerKey();

    const signer = service.registerSigner('acct-1', { publicKey: key, label: 'iPhone 15' });

    expect(signer.signerId).toMatch(/^sg-[0-9a-f]{12}$/);
    expect(signer.publicKey).toBe(key);
    expect(signer.label).toBe('iPhone 15');
    expect(store.listSigners('acct-1')).toEqual([signer]);
  });

  it('is idempotent per (accountId, publicKey): re-registering returns the same id, label updated', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);
    const key = freshSignerKey();

    const first = service.registerSigner('acct-1', { publicKey: key, label: 'iPhone 15' });
    const second = service.registerSigner('acct-1', { publicKey: key, label: 'iPhone 15 Pro' });

    expect(second.signerId).toBe(first.signerId);
    expect(second.label).toBe('iPhone 15 Pro');
    expect(store.listSigners('acct-1')).toHaveLength(1);
  });

  it('rejects a key that does not base64url-decode to 32 bytes, without persisting anything', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);
    const shortKey = randomBytes(31).toString('base64url');

    expect(() => service.registerSigner('acct-1', { publicKey: shortKey, label: 'bad' })).toThrow(
      InvalidPublicKeyError,
    );
    expect(store.listSigners('acct-1')).toEqual([]);
  });

  it('rejects malformed base64url, without persisting anything', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);

    expect(() =>
      service.registerSigner('acct-1', { publicKey: 'not valid base64url!!', label: 'bad' }),
    ).toThrow(InvalidPublicKeyError);
    expect(store.listSigners('acct-1')).toEqual([]);
  });

  it('rejects a non-canonical encoding (padded / non-base64url alphabet) even though it decodes to 32 bytes', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);
    const raw = randomBytes(32);
    const paddedKey = `${raw.toString('base64url')}==`;
    const standardBase64Key = raw.toString('base64'); // may contain '+'/'/'

    expect(() => service.registerSigner('acct-1', { publicKey: paddedKey, label: 'bad' })).toThrow(
      InvalidPublicKeyError,
    );
    expect(() =>
      service.registerSigner('acct-1', { publicKey: standardBase64Key, label: 'bad' }),
    ).toThrow(InvalidPublicKeyError);
    expect(store.listSigners('acct-1')).toEqual([]);
  });

  it('allows the same public key to be registered independently by different accounts', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);
    const key = freshSignerKey();

    const a1 = service.registerSigner('acct-1', { publicKey: key, label: 'A' });
    const a2 = service.registerSigner('acct-2', { publicKey: key, label: 'B' });

    expect(a1.signerId).not.toBe(a2.signerId);
  });
});

describe('ProvisioningService.listSigners', () => {
  it('returns only the calling account’s signers', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    service.registerSigner('acct-1', { publicKey: freshSignerKey(), label: 'a' });
    service.registerSigner('acct-2', { publicKey: freshSignerKey(), label: 'b' });

    expect(service.listSigners('acct-1')).toHaveLength(1);
    expect(service.listSigners('acct-1')[0]?.label).toBe('a');
  });

  it('returns an empty list for an account with no signers', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);
    expect(service.listSigners('acct-1')).toEqual([]);
  });
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Pairing provisioning rides a REAL relay so the minted credential is verified
// against the same store the relay's hot path reads — dogfooding the contract.
describe('ProvisioningService pairings', () => {
  let server: RelayServer;
  let relayStore: DurableCredentialStore;
  let relay: RelayAdminClient;

  beforeEach(async () => {
    relayStore = new DurableCredentialStore(':memory:');
    server = createRelayServer(hostedRelayAuth({ publicKey, store: relayStore }), {
      admin: { secret: 'master', store: relayStore },
    });
    await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', () => r()));
    const port = (server.httpServer.address() as AddressInfo).port;
    relay = new RelayAdminClient(`http://127.0.0.1:${port}`, 'master');
  });

  afterEach(async () => {
    await server.close();
  });

  function makeRealService(now: () => number = () => 1000, approvalTtlMs?: number) {
    const store = new SqliteStore(':memory:');
    const signer = new DialTokenSigner(privateKey, 3600, () => 1000);
    const service = new ProvisioningService({
      store,
      signer,
      relay,
      relayZone: 'relay.example.com',
      now,
      approvalTtlMs,
    });
    return { store, service };
  }

  it('mints a credential the relay validates and stores only its hash', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    const { credential, pairingId } = asActive(
      await service.createPairing('acct-1', gw.gatewayId, 'iPhone'),
    );

    // The relay's hot path accepts the credential under this gateway.
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(true);

    // The store persisted a pairing with the SHA-256 hash, the label, and no raw secret.
    const pairings = store.listPairings(gw.gatewayId);
    expect(pairings).toHaveLength(1);
    expect(pairingId).toBe(pairings[0].id);
    expect(pairings[0].credentialHash).toBe(sha256(credential));
    expect(pairings[0].credentialHash).not.toBe(credential);
    expect(pairings[0].deviceLabel).toBe('iPhone');
    expect(pairings[0].status).toBe('active');
  });

  it('defaults the device label to null when omitted', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    await service.createPairing('acct-1', gw.gatewayId);

    expect(store.listPairings(gw.gatewayId)[0].deviceLabel).toBeNull();
  });

  it('defaults the client kind to mobile when omitted', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    await service.createPairing('acct-1', gw.gatewayId, 'iPhone');

    expect(store.listPairings(gw.gatewayId)[0].clientKind).toBe('mobile');
  });

  it('persists an explicit web client kind', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    // Web pairings require a registered chat token (see setWebChatToken).
    service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');

    await service.createPairing('acct-1', gw.gatewayId, 'Safari on iPhone', 'web');

    expect(store.listPairings(gw.gatewayId)[0].clientKind).toBe('web');
  });

  it('setWebChatToken stores a token the owner can register and re-register', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    expect(service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1')).toBe(true);
    expect(store.getWebChatToken(gw.gatewayId)).toBe('chat-1');
    expect(service.setWebChatToken('acct-1', gw.gatewayId, 'chat-2')).toBe(true);
    expect(store.getWebChatToken(gw.gatewayId)).toBe('chat-2');
  });

  it('setWebChatToken refuses a cross-account or unknown gateway without writing', () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    expect(service.setWebChatToken('acct-2', gw.gatewayId, 'chat-1')).toBe(false);
    expect(service.setWebChatToken('acct-1', 'gw-missing', 'chat-1')).toBe(false);
    expect(store.getWebChatToken(gw.gatewayId)).toBeNull();
  });

  it('returns the registered chat token alongside a web pairing', async () => {
    const { service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');

    const created = asActive(await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web'));

    expect(created.chatToken).toBe('chat-1');
    expect(created.credential).toBeTruthy();
    expect(created.pairingId).toBeTruthy();
    expect(created.status).toBe('active');
  });

  it('returns the registered chat token for an account-authenticated mobile pairing too', async () => {
    const { service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');

    const created = asActive(
      await service.createPairing('acct-1', gw.gatewayId, 'iPhone', 'mobile'),
    );

    expect(created.chatToken).toBe('chat-1');
    expect(created.status).toBe('active');
  });

  it('omits the chat token (and never throws) for a mobile pairing when none is registered — MC/Android compat', async () => {
    const { service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    const created = asActive(await service.createPairing('acct-1', gw.gatewayId, 'iPhone'));

    expect(created.chatToken).toBeUndefined();
    expect(created.status).toBe('active');
  });

  it('refuses a web pairing before minting when no chat token is registered', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    await expect(
      service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web'),
    ).rejects.toBeInstanceOf(WebChatTokenMissingError);

    // Nothing was minted or persisted — a failed web pairing leaves no orphan
    // pairing row and no credential the relay would still honour.
    expect(store.listPairings(gw.gatewayId)).toHaveLength(0);
  });

  it('refuses a cross-account createPairing: throws, no relay credential minted', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    await expect(service.createPairing('acct-2', gw.gatewayId, 'iPhone')).rejects.toThrow();

    // No pairing persisted and no credential minted on the relay.
    expect(store.listPairings(gw.gatewayId)).toEqual([]);
  });

  it('throws for an unknown gateway', async () => {
    const { service } = makeRealService();
    await expect(service.createPairing('acct-1', 'gw-missing')).rejects.toThrow();
  });

  it('deletePairing revokes on the relay and in the store', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    const { credential } = asActive(await service.createPairing('acct-1', gw.gatewayId, 'iPhone'));
    const pairingId = store.listPairings(gw.gatewayId)[0].id;

    const ok = await service.deletePairing('acct-1', gw.gatewayId, pairingId);

    expect(ok).toBe(true);
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(false);
    expect(store.listPairings(gw.gatewayId)[0].status).toBe('revoked');
  });

  it('deletePairing revokes only the targeted device, leaving the others paired', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    const { credential: credA } = asActive(
      await service.createPairing('acct-1', gw.gatewayId, 'iPhone'),
    );
    const { credential: credB } = asActive(
      await service.createPairing('acct-1', gw.gatewayId, 'iPad'),
    );
    const pairingA = store.listPairings(gw.gatewayId).find((p) => p.deviceLabel === 'iPhone');
    if (!pairingA) throw new Error('expected an iPhone pairing');

    const ok = await service.deletePairing('acct-1', gw.gatewayId, pairingA.id);

    expect(ok).toBe(true);
    // Only the iPhone is revoked on the relay; the iPad stays paired.
    expect(relayStore.isValid(gw.gatewayId, credA)).toBe(false);
    expect(relayStore.isValid(gw.gatewayId, credB)).toBe(true);
    // The store mirrors it: iPhone revoked, iPad still active.
    const after = store.listPairings(gw.gatewayId);
    expect(after.find((p) => p.id === pairingA.id)?.status).toBe('revoked');
    expect(after.find((p) => p.deviceLabel === 'iPad')?.status).toBe('active');
  });

  it('refuses a cross-account deletePairing: returns false, store and relay untouched', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    const { credential } = asActive(await service.createPairing('acct-1', gw.gatewayId, 'iPhone'));
    const pairingId = store.listPairings(gw.gatewayId)[0].id;

    const ok = await service.deletePairing('acct-2', gw.gatewayId, pairingId);

    expect(ok).toBe(false);
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(true);
    expect(store.listPairings(gw.gatewayId)[0].status).toBe('active');
  });

  describe('signer-gated web approvals (Task 3)', () => {
    function signerKeypair() {
      const { publicKey: pub, privateKey: priv } = generateKeyPairSync('ed25519');
      const rawPub = (pub.export({ format: 'jwk' }) as { x: string }).x;
      return { rawPub, priv };
    }

    function signDecision(
      priv: ReturnType<typeof generateKeyPairSync>['privateKey'],
      approvalId: string,
      pairingId: string,
      decision: 'approve' | 'deny',
    ): string {
      const message = approvalMessage(approvalId, pairingId, decision);
      return sign(null, Buffer.from(message, 'utf8'), priv).toString('base64url');
    }

    it('gates a web mint behind a pending approval once a signer is registered, withholding all secrets', async () => {
      const { store, service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const { rawPub } = signerKeypair();
      service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const result = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');

      expect(result).toEqual({
        pairingId: expect.any(String),
        status: 'pending',
        approvalId: expect.any(String),
        approvalExpiresAt: expect.any(Number),
      });
      expect('credential' in result).toBe(false);
      expect('chatToken' in result).toBe(false);

      const pending = store.listPairings(gw.gatewayId)[0];
      expect(pending.status).toBe('pending');
    });

    it('full happy path: register signer -> pending mint -> real-key signed approval -> active -> claim once -> 410-shaped on second claim', async () => {
      const { store, service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const { rawPub, priv } = signerKeypair();
      const signerRecord = service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const minted = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');
      if (minted.status !== 'pending') throw new Error('expected a pending approval');

      const fetched = service.getApproval('acct-1', minted.approvalId);
      expect(fetched).toMatchObject({
        approvalId: minted.approvalId,
        pairingId: minted.pairingId,
        gatewayId: gw.gatewayId,
        deviceLabel: 'Safari',
      });

      const signature = signDecision(priv, minted.approvalId, minted.pairingId, 'approve');
      await service.decideApproval('acct-1', minted.approvalId, {
        decision: 'approve',
        signerId: signerRecord.signerId,
        signature,
      });

      const activated = store.listPairings(gw.gatewayId).find((p) => p.id === minted.pairingId);
      expect(activated?.status).toBe('active');

      const claimed = service.claimCredential('acct-1', gw.gatewayId, minted.pairingId);
      expect(claimed).toEqual({ kind: 'ok', credential: expect.any(String), chatToken: 'chat-1' });
      if (claimed.kind === 'ok') {
        expect(relayStore.isValid(gw.gatewayId, claimed.credential)).toBe(true);
      }

      const secondClaim = service.claimCredential('acct-1', gw.gatewayId, minted.pairingId);
      expect(secondClaim).toEqual({ kind: 'claimed' });
    });

    it('claim reports pending before a decision is made', async () => {
      const { service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const { rawPub } = signerKeypair();
      service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const minted = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');
      if (minted.status !== 'pending') throw new Error('expected pending');

      expect(service.claimCredential('acct-1', gw.gatewayId, minted.pairingId)).toEqual({
        kind: 'pending',
      });
    });

    it('deny deletes the pending pairing outright, and a claim afterwards reports not-found', async () => {
      const { store, service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const { rawPub, priv } = signerKeypair();
      const signerRecord = service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const minted = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');
      if (minted.status !== 'pending') throw new Error('expected pending');

      const signature = signDecision(priv, minted.approvalId, minted.pairingId, 'deny');
      await service.decideApproval('acct-1', minted.approvalId, {
        decision: 'deny',
        signerId: signerRecord.signerId,
        signature,
      });

      expect(store.listPairings(gw.gatewayId)).toEqual([]);
      expect(service.claimCredential('acct-1', gw.gatewayId, minted.pairingId)).toEqual({
        kind: 'not-found',
      });
    });

    it('expiry: a decision attempt after the TTL throws ApprovalClosedError and removes the orphan pairing', async () => {
      let clock = 1_000_000;
      const { store, service } = makeRealService(() => clock, 120_000);
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const { rawPub, priv } = signerKeypair();
      const signerRecord = service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const minted = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');
      if (minted.status !== 'pending') throw new Error('expected pending');

      clock += 120_001; // one ms past the 120s TTL
      const signature = signDecision(priv, minted.approvalId, minted.pairingId, 'approve');

      await expect(
        service.decideApproval('acct-1', minted.approvalId, {
          decision: 'approve',
          signerId: signerRecord.signerId,
          signature,
        }),
      ).rejects.toBeInstanceOf(ApprovalClosedError);

      expect(store.listPairings(gw.gatewayId)).toEqual([]);
    });

    it('wrong-account approval fetch returns null (the route answers 404)', async () => {
      const { service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const { rawPub } = signerKeypair();
      service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const minted = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');
      if (minted.status !== 'pending') throw new Error('expected pending');

      expect(service.getApproval('acct-2', minted.approvalId)).toBeNull();
    });

    it('a signature over the wrong message (tampered decision) is rejected, leaving the approval pending', async () => {
      const { store, service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const { rawPub, priv } = signerKeypair();
      const signerRecord = service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const minted = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');
      if (minted.status !== 'pending') throw new Error('expected pending');

      // Sign 'deny' but submit 'approve' — the signature does not cover the
      // decision actually being requested.
      const signature = signDecision(priv, minted.approvalId, minted.pairingId, 'deny');

      await expect(
        service.decideApproval('acct-1', minted.approvalId, {
          decision: 'approve',
          signerId: signerRecord.signerId,
          signature,
        }),
      ).rejects.toBeInstanceOf(InvalidApprovalSignatureError);

      // Still pending — a rejected forgery does not burn the approval.
      expect(store.listPairings(gw.gatewayId).find((p) => p.id === minted.pairingId)?.status).toBe(
        'pending',
      );
    });

    it('a signer id that does not belong to the account is rejected the same as a bad signature', async () => {
      const { service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');
      const outsider = signerKeypair();
      service.registerSigner('acct-2', { publicKey: outsider.rawPub, label: 'outsider phone' });
      const insider = signerKeypair();
      service.registerSigner('acct-1', { publicKey: insider.rawPub, label: 'real iPhone' });

      const minted = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');
      if (minted.status !== 'pending') throw new Error('expected pending');

      const signature = signDecision(outsider.priv, minted.approvalId, minted.pairingId, 'approve');
      const crossAccountSigner = service.listSigners('acct-2')[0];

      await expect(
        service.decideApproval('acct-1', minted.approvalId, {
          decision: 'approve',
          signerId: crossAccountSigner.signerId,
          signature,
        }),
      ).rejects.toBeInstanceOf(InvalidApprovalSignatureError);
    });

    it('zero-signer accounts mint immediately, byte-compatible with today', async () => {
      const { service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      service.setWebChatToken('acct-1', gw.gatewayId, 'chat-1');

      const result = await service.createPairing('acct-1', gw.gatewayId, 'Safari', 'web');

      expect(result).toEqual({
        credential: expect.any(String),
        pairingId: expect.any(String),
        chatToken: 'chat-1',
        status: 'active',
      });
    });

    it('mobile mints are unaffected even when the account has registered signers', async () => {
      const { store, service } = makeRealService();
      const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
      const { rawPub } = signerKeypair();
      service.registerSigner('acct-1', { publicKey: rawPub, label: 'iPhone' });

      const result = await service.createPairing('acct-1', gw.gatewayId, 'iPhone', 'mobile');

      expect(result).toEqual({
        credential: expect.any(String),
        pairingId: expect.any(String),
        status: 'active',
      });
      expect(store.listPairings(gw.gatewayId)[0].status).toBe('active');
    });
  });
});
