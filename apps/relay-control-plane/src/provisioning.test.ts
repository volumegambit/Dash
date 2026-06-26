import { createHash, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DurableCredentialStore,
  type RelayServer,
  createRelayServer,
  hostedRelayAuth,
  verifyDialToken,
} from '@dash/relay';
import { DialTokenSigner } from './dial-token-signer.js';
import { ProvisioningService } from './provisioning.js';
import { RelayAdminClient } from './relay-admin-client.js';
import { SqliteStore } from './store.js';

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

  function makeRealService() {
    const store = new SqliteStore(':memory:');
    const signer = new DialTokenSigner(privateKey, 3600, () => 1000);
    const service = new ProvisioningService({
      store,
      signer,
      relay,
      relayZone: 'relay.example.com',
    });
    return { store, service };
  }

  it('mints a credential the relay validates and stores only its hash', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });

    const { credential } = await service.createPairing('acct-1', gw.gatewayId, 'iPhone');

    // The relay's hot path accepts the credential under this gateway.
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(true);

    // The store persisted a pairing with the SHA-256 hash, the label, and no raw secret.
    const pairings = store.listPairings(gw.gatewayId);
    expect(pairings).toHaveLength(1);
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
    const { credential } = await service.createPairing('acct-1', gw.gatewayId, 'iPhone');
    const pairingId = store.listPairings(gw.gatewayId)[0].id;

    const ok = await service.deletePairing('acct-1', gw.gatewayId, pairingId);

    expect(ok).toBe(true);
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(false);
    expect(store.listPairings(gw.gatewayId)[0].status).toBe('revoked');
  });

  it('deletePairing revokes only the targeted device, leaving the others paired', async () => {
    const { store, service } = makeRealService();
    const gw = service.createGateway('acct-1', { subdomain: 'alice', publicKey: 'pk-a' });
    const { credential: credA } = await service.createPairing('acct-1', gw.gatewayId, 'iPhone');
    const { credential: credB } = await service.createPairing('acct-1', gw.gatewayId, 'iPad');
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
    const { credential } = await service.createPairing('acct-1', gw.gatewayId, 'iPhone');
    const pairingId = store.listPairings(gw.gatewayId)[0].id;

    const ok = await service.deletePairing('acct-2', gw.gatewayId, pairingId);

    expect(ok).toBe(false);
    expect(relayStore.isValid(gw.gatewayId, credential)).toBe(true);
    expect(store.listPairings(gw.gatewayId)[0].status).toBe('active');
  });
});
