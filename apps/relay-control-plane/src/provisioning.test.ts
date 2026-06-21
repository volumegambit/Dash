import { generateKeyPairSync } from 'node:crypto';
import { verifyDialToken } from '@dash/relay';
import { DialTokenSigner } from './dial-token-signer.js';
import { ProvisioningService } from './provisioning.js';
import type { RelayAdminClient } from './relay-admin-client.js';
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
  it('mints a DNS-safe gateway id, subdomain, and a relay-verifiable dial token', () => {
    const { client } = spyRelayClient();
    const { store, service } = makeService(client);

    const result = service.createGateway('acct-1');

    expect(result.gatewayId).toMatch(/^gw-[0-9a-f]+$/);
    expect(result.gatewayId.length).toBeLessThanOrEqual(63);
    expect(result.subdomain).toBe(`${result.gatewayId}.relay.example.com`);

    // The dial token the relay would verify, bound to this gateway.
    const claims = verifyDialToken(result.dialToken, publicKey, 1000);
    expect(claims).toEqual({ tenantId: 'acct-1', gatewayId: result.gatewayId, exp: 4600 });

    // The store persisted the gateway under the owning account.
    const record = store.getGateway(result.gatewayId);
    expect(record).not.toBeNull();
    expect(record?.accountId).toBe('acct-1');
    expect(record?.subdomain).toBe(result.subdomain);
    expect(record?.status).toBe('active');
    expect(store.listGateways('acct-1').map((g) => g.gatewayId)).toContain(result.gatewayId);
  });

  it('generates a fresh gateway id per call', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    const a = service.createGateway('acct-1');
    const b = service.createGateway('acct-1');
    expect(a.gatewayId).not.toBe(b.gatewayId);
  });
});

describe('ProvisioningService.listGateways', () => {
  it('returns only the calling account’s gateways', () => {
    const { client } = spyRelayClient();
    const { service } = makeService(client);

    const a1 = service.createGateway('acct-1');
    service.createGateway('acct-2');

    const list = service.listGateways('acct-1');
    expect(list.map((g) => g.gatewayId)).toEqual([a1.gatewayId]);
  });
});

describe('ProvisioningService.deleteGateway', () => {
  it('refuses a wrong-owner delete: returns false, store untouched, no relay call', async () => {
    const { client, calls } = spyRelayClient();
    const { store, service } = makeService(client);

    const gw = service.createGateway('acct-1');

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

    const gw = service.createGateway('acct-1');

    const ok = await service.deleteGateway('acct-1', gw.gatewayId);
    expect(ok).toBe(true);
    expect(store.getGateway(gw.gatewayId)?.status).toBe('revoked');
    expect(calls.revokeGateway).toEqual([['acct-1', gw.gatewayId]]);
  });
});
