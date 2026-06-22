import { createHash, randomBytes } from 'node:crypto';
import type { DialTokenSigner } from './dial-token-signer.js';
import type { RelayAdminClient } from './relay-admin-client.js';
import type { GatewayRecord, PairingRecord, Store } from './store.js';

/** Result of provisioning a new gateway: its id, subdomain, and a dial token. */
export interface CreatedGateway {
  gatewayId: string;
  subdomain: string;
  dialToken: string;
}

/** Result of provisioning a pairing: the one-time credential for the device. */
export interface CreatedPairing {
  credential: string;
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
   * Re-sign a dial token for one of `accountId`'s gateways (token refresh).
   * Ownership is checked first: a gateway the caller does not own — or an
   * unknown id — returns `null` and mints nothing.
   */
  refreshDialToken(accountId: string, gatewayId: string): string | null {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) return null;
    return this.#signer.signFor(accountId, gatewayId);
  }

  /**
   * List the pairings for one of `accountId`'s gateways. Returns `null` (not an
   * empty array) when the gateway is unknown or owned by another account, so the
   * caller can distinguish "no pairings" from "not yours".
   */
  listPairings(accountId: string, gatewayId: string): PairingRecord[] | null {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) return null;
    return this.#store.listPairings(gatewayId);
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

  /**
   * Provision a pairing credential for one of `accountId`'s gateways. Ownership
   * is enforced first (the gateway must belong to the caller) — a cross-account
   * or unknown-gateway request throws and never reaches the relay. The relay
   * mints the credential; only its SHA-256 hash is persisted, never the raw
   * secret, which is returned once to the caller.
   */
  async createPairing(
    accountId: string,
    gatewayId: string,
    deviceLabel?: string,
  ): Promise<CreatedPairing> {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) {
      throw new Error(`gateway ${gatewayId} not found for account ${accountId}`);
    }
    const credential = await this.#relay.provisionPairing(accountId, gatewayId);
    this.#store.addPairing({
      id: generatePairingId(),
      gatewayId,
      credentialHash: sha256(credential),
      deviceLabel: deviceLabel ?? null,
    });
    return { credential };
  }

  /**
   * Revoke a pairing. Ownership is checked in the store first; only on a real
   * revocation does the relay invalidate the credential. Returns false (and
   * skips the relay) when the caller does not own the gateway or the pairing is
   * unknown.
   */
  async deletePairing(accountId: string, gatewayId: string, pairingId: string): Promise<boolean> {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) return false;
    const revoked = this.#store.revokePairing(gatewayId, pairingId);
    if (!revoked) return false;
    await this.#relay.revokePairing(accountId, gatewayId);
    return true;
  }
}

/** A DNS-safe, lowercase `gw-<hex>` id well under the 63-char label limit. */
function generateGatewayId(): string {
  return `gw-${randomBytes(12).toString('hex')}`;
}

/** A unique pairing id. */
function generatePairingId(): string {
  return `pr-${randomBytes(12).toString('hex')}`;
}

/** SHA-256 hex digest — the only form a credential is stored in at rest. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
