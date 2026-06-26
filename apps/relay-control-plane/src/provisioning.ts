import { createHash, randomBytes } from 'node:crypto';
import type { DialTokenSigner } from './dial-token-signer.js';
import type { RelayAdminClient } from './relay-admin-client.js';
import type { GatewayRecord, PairingRecord, Store } from './store.js';
import { validateSubdomainLabel } from './subdomain.js';

/** Thrown when a requested subdomain label is not DNS-safe or is reserved. */
export class InvalidSubdomainError extends Error {}
/** Thrown when a label is already claimed (active or burned — never recycled). */
export class SubdomainTakenError extends Error {}
/** Thrown when the supplied gateway public key is empty/malformed. */
export class InvalidPublicKeyError extends Error {}

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
   * Provision a new gateway for `accountId` at the user-chosen `subdomain` label.
   *
   * The label IS the gatewayId (permanent, globally unique, never recycled): we
   * validate it, assert it is available across ALL statuses, persist the gateway
   * with its public key, and return a control-plane-signed dial token whose `cnf`
   * binds the token to that key. Throws on an invalid/taken label or empty key —
   * nothing is persisted on the failure paths.
   */
  createGateway(accountId: string, opts: { subdomain: string; publicKey: string }): CreatedGateway {
    const label = opts.subdomain;
    if (!validateSubdomainLabel(label)) {
      throw new InvalidSubdomainError(`invalid subdomain label: ${label}`);
    }
    if (!opts.publicKey) {
      throw new InvalidPublicKeyError('gateway public key required');
    }
    if (!this.#store.isSubdomainAvailable(label)) {
      throw new SubdomainTakenError(`subdomain taken: ${label}`);
    }
    this.#store.createAccount(accountId);
    const gatewayId = label;
    const subdomain = `${label}.${this.#relayZone}`;
    this.#store.createGateway({ gatewayId, accountId, subdomain, publicKey: opts.publicKey });
    const dialToken = this.#signer.signFor(accountId, gatewayId, opts.publicKey);
    return { gatewayId, subdomain, dialToken };
  }

  /** True iff `label` is valid AND unclaimed in any status (for the picker). */
  isSubdomainAvailable(label: string): boolean {
    return validateSubdomainLabel(label) && this.#store.isSubdomainAvailable(label);
  }

  /** List the gateways owned by `accountId`. */
  listGateways(accountId: string): GatewayRecord[] {
    return this.#store.listGateways(accountId);
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
   * Revoke a single pairing. Ownership is checked in the store first; only on a
   * real revocation does the relay invalidate that one credential. Returns false
   * (and skips the relay) when the caller does not own the gateway or the pairing
   * is unknown.
   *
   * The relay is told exactly which device to drop via its hash — never every
   * credential for the gateway. We hold only the hash (the raw secret was
   * returned once at provisioning and never persisted), so we pass it to the
   * relay's hash-keyed revoke path.
   */
  async deletePairing(accountId: string, gatewayId: string, pairingId: string): Promise<boolean> {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) return false;
    // Capture the credential hash before revoking so we can target this one
    // device on the relay; a missing pairing means there is nothing to revoke.
    const pairing = this.#store.listPairings(gatewayId).find((p) => p.id === pairingId);
    if (!pairing) return false;
    const revoked = this.#store.revokePairing(gatewayId, pairingId);
    if (!revoked) return false;
    await this.#relay.revokePairing(
      accountId,
      gatewayId,
      undefined,
      hexToRelayHash(pairing.credentialHash),
    );
    return true;
  }
}

/** A unique pairing id. */
function generatePairingId(): string {
  return `pr-${randomBytes(12).toString('hex')}`;
}

/** SHA-256 hex digest — the only form a credential is stored in at rest. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Re-encode our hex SHA-256 digest as base64url — the form the relay keys
 * pairings by (its {@link DurableCredentialStore} stores base64url). Same 32
 * hash bytes, different text; the conversion is exact and lossless.
 */
function hexToRelayHash(hexDigest: string): string {
  return Buffer.from(hexDigest, 'hex').toString('base64url');
}
