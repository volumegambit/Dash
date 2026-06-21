import { randomBytes } from 'node:crypto';
import type { DialTokenSigner } from './dial-token-signer.js';
import type { RelayAdminClient } from './relay-admin-client.js';
import type { GatewayRecord, Store } from './store.js';

/** Result of provisioning a new gateway: its id, subdomain, and a dial token. */
export interface CreatedGateway {
  gatewayId: string;
  subdomain: string;
  dialToken: string;
}

/** Collaborators the {@link ProvisioningService} orchestrates. */
export interface ProvisioningDeps {
  store: Store;
  signer: DialTokenSigner;
  relay: RelayAdminClient;
  /** DNS zone subdomains hang off, e.g. `relay.example.com`. */
  relayZone: string;
}

/**
 * Orchestrates gateway (and, in Task 7, pairing) provisioning across the store,
 * the dial-token signer, and the relay admin API.
 *
 * For v1 `tenantId == accountId`. Ownership is enforced through the store before
 * any relay call: a wrong-owner delete touches nothing and never reaches the relay.
 */
export class ProvisioningService {
  readonly #store: Store;
  readonly #signer: DialTokenSigner;
  readonly #relay: RelayAdminClient;
  readonly #relayZone: string;

  constructor(deps: ProvisioningDeps) {
    this.#store = deps.store;
    this.#signer = deps.signer;
    this.#relay = deps.relay;
    this.#relayZone = deps.relayZone;
  }

  /**
   * Provision a new gateway for `accountId`: mint a DNS-safe id, persist it, and
   * return a control-plane-signed dial token the relay will verify on dial-in.
   */
  createGateway(accountId: string): CreatedGateway {
    this.#store.createAccount(accountId);
    const gatewayId = generateGatewayId();
    const subdomain = `${gatewayId}.${this.#relayZone}`;
    this.#store.createGateway({ gatewayId, accountId, subdomain });
    const dialToken = this.#signer.signFor(accountId, gatewayId);
    return { gatewayId, subdomain, dialToken };
  }

  /** List the gateways owned by `accountId`. */
  listGateways(accountId: string): GatewayRecord[] {
    return this.#store.listGateways(accountId);
  }

  /**
   * Revoke a gateway. Ownership is checked in the store first; only on a real
   * revocation does the relay force-close the live tunnel. Returns false (and
   * skips the relay) when the caller does not own the gateway.
   */
  async deleteGateway(accountId: string, gatewayId: string): Promise<boolean> {
    const revoked = this.#store.revokeGateway(accountId, gatewayId);
    if (!revoked) return false;
    await this.#relay.revokeGateway(accountId, gatewayId);
    return true;
  }
}

/** A DNS-safe, lowercase `gw-<hex>` id well under the 63-char label limit. */
function generateGatewayId(): string {
  return `gw-${randomBytes(12).toString('hex')}`;
}
