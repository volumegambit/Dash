import { type KeyObject, createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { DialTokenSigner } from './dial-token-signer.js';
import type { RelayAdminClient } from './relay-admin-client.js';
import type {
  ApprovalRecord,
  ClientKind,
  GatewayRecord,
  PairingRecord,
  SignerRecord,
  Store,
} from './store.js';
import { validateSubdomainLabel } from './subdomain.js';

/** Thrown when a requested subdomain label is not DNS-safe or is reserved. */
export class InvalidSubdomainError extends Error {}
/** Thrown when a label is already claimed (active or burned — never recycled). */
export class SubdomainTakenError extends Error {}
/**
 * Thrown when a supplied public key is empty/malformed — the gateway pubkey
 * (any non-empty string) or a signer pubkey (must base64url-decode to exactly
 * 32 raw Ed25519 bytes and re-encode back to the identical string).
 */
export class InvalidPublicKeyError extends Error {}
/**
 * Thrown when a `'web'` pairing is requested for a gateway whose owner has not
 * yet registered a web chat token (Mission Control uploads it during the
 * Remote-access enroll flow). Distinct from the not-found path so the HTTP
 * layer can answer 409 — the gateway exists and is yours, it just is not ready
 * for browser clients.
 */
export class WebChatTokenMissingError extends Error {}
/**
 * Thrown by {@link ProvisioningService.decideApproval}: the approval id does
 * not exist, OR it exists under a different account than the caller.
 * Deliberately a single case (never disclosing which) — the HTTP layer
 * answers 404 either way, mirroring every other cross-account lookup in this
 * service. `ProvisioningService.getApproval` uses the same rule but returns
 * `null` instead of throwing, since its caller is a GET route.
 */
export class ApprovalNotFoundError extends Error {}
/**
 * Thrown by {@link ProvisioningService.decideApproval} when the approval is
 * no longer decidable: either its TTL has elapsed, or it already received a
 * decision. Both map to `410 Gone` at the HTTP layer — from the caller's
 * perspective "too late" and "already answered" are the same outcome, a
 * fresh approval must be minted.
 */
export class ApprovalClosedError extends Error {}
/**
 * Thrown by {@link ProvisioningService.decideApproval} when the Ed25519
 * signature does not verify over the exact {@link approvalMessage}, OR when
 * `signerId` does not resolve to a signer registered under the approval's
 * account. The two failure modes are deliberately indistinguishable to the
 * caller (both → `403`) — a signer id from another account carries no more
 * trust than a forged signature.
 */
export class InvalidApprovalSignatureError extends Error {}

/** Result of provisioning a new gateway: its id, subdomain, and a dial token. */
export interface CreatedGateway {
  gatewayId: string;
  subdomain: string;
  dialToken: string;
}

/** Result of provisioning a pairing: its nonsecret id and one-time credential. */
export interface CreatedPairing {
  credential: string;
  pairingId: string;
  /**
   * The gateway's chat-scoped bearer, present whenever the gateway has a
   * registered web chat token (see `Store.setWebChatToken`). Always present
   * for `'web'` pairings — a browser has no QR channel to receive it out of
   * band, so a missing registration throws `WebChatTokenMissingError` before
   * this point instead. Present for `'mobile'`/account-authenticated pairings
   * only when a token happens to be registered; absence is never an error, so
   * legacy MC-driven mints for Android QR pairing keep their exact
   * historical response shape.
   */
  chatToken?: string;
  /**
   * Lifecycle status of the freshly minted pairing — always the literal
   * `'active'` (a fresh immediate mint is never created pre-revoked). A
   * signer-gated web mint returns {@link PendingApproval} instead of this
   * type, which is what makes the two shapes discriminable on `status`.
   */
  status: 'active';
}

/**
 * Result of minting a signer-gated web pairing (Task 3): no credential, no
 * chat token — both stay withheld until a signer approves (see
 * `ProvisioningService.decideApproval`) and the caller claims them exactly
 * once (`ProvisioningService.claimCredential`). `pairingId` already exists in
 * the store with `status: 'pending'`; the web app polls
 * `GET /v1/gateways/:id/pairings` for that status to flip.
 */
export interface PendingApproval {
  pairingId: string;
  status: 'pending';
  approvalId: string;
  /** Unix milliseconds — matches every other timestamp this store returns. */
  approvalExpiresAt: number;
}

/** The caller-facing decision value — the literal wire form signed over (see {@link approvalMessage}). */
export type ApprovalDecision = 'approve' | 'deny';

/** Default approval TTL: 120 seconds, per the signer-device design spec. */
const DEFAULT_APPROVAL_TTL_MS = 120_000;

/**
 * The exact UTF-8 message an approval decision is signed over. THIS is the
 * single documented source of truth both this control plane and the separate
 * iOS codebase (Tasks 5/6) must independently reproduce byte-for-byte — every
 * signer and verifier in this repo MUST build the message through this
 * function rather than inlining the template, so the two implementations
 * cannot silently drift apart.
 *
 * Wire format: `${approvalId}\n${pairingId}\n${decision}`, encoded UTF-8.
 * `decision` is the literal wire value (`'approve'` or `'deny'`), never a
 * normalized/aliased form.
 */
export function approvalMessage(
  approvalId: string,
  pairingId: string,
  decision: ApprovalDecision,
): string {
  return `${approvalId}\n${pairingId}\n${decision}`;
}

/**
 * Decode a raw 32-byte base64url Ed25519 public key into a verifiable
 * `KeyObject` via JWK — identical convention to
 * `apps/relay/src/assertion.ts`'s `rawEd25519ToKeyObject`. Returns `null` on
 * any malformed input (never throws).
 */
function rawEd25519ToKeyObject(raw: string): KeyObject | null {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * Verify `signatureB64url` (base64url) over `message` (UTF-8) with `key`.
 * Never throws — a malformed signature (wrong length/encoding) is a `false`,
 * exactly like a merely-wrong one, mirroring `apps/relay/src/assertion.ts`'s
 * `verifyAssertion`.
 */
function safeVerify(message: string, signatureB64url: string, key: KeyObject): boolean {
  try {
    return verify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signatureB64url, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** Result of {@link ProvisioningService.claimCredential} — a discriminated union over `kind`. */
export type ClaimResult =
  | { kind: 'not-found' }
  | { kind: 'pending' }
  | { kind: 'claimed' }
  | { kind: 'ok'; credential: string; chatToken?: string };

/** Collaborators the {@link ProvisioningService} orchestrates. */
export interface ProvisioningDeps {
  store: Store;
  signer: DialTokenSigner;
  relay: RelayAdminClient;
  /** DNS zone subdomains hang off, e.g. `relay.example.com`. */
  relayZone: string;
  /**
   * Clock (unix MILLISECONDS — matches the store's `createdAt`/`expiresAt`,
   * NOT `DialTokenSigner`'s unix-seconds clock) used to stamp and check
   * approval expiry. Defaults to `Date.now`; tests inject a fixed/advancing
   * clock, the same `#now()` injection pattern as `DialTokenSigner` and
   * `GatewayAssertionAuthenticator`.
   */
  now?: () => number;
  /** Approval TTL in milliseconds. Defaults to 120 000 (120s, per the signer-device design spec). */
  approvalTtlMs?: number;
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
  readonly #now: () => number;
  readonly #approvalTtlMs: number;

  constructor(deps: ProvisioningDeps) {
    this.#store = deps.store;
    this.#signer = deps.signer;
    this.#relay = deps.relay;
    this.#relayZone = deps.relayZone;
    this.#now = deps.now ?? Date.now;
    this.#approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
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
   * Register the chat-scoped bearer that browser pairings for `gatewayId` will
   * receive. Ownership is enforced here: a cross-account or unknown gateway
   * returns false and writes nothing. Idempotent — Mission Control re-uploads
   * on every enroll refresh, and the latest value wins.
   */
  setWebChatToken(accountId: string, gatewayId: string, chatToken: string): boolean {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) return false;
    return this.#store.setWebChatToken(gatewayId, chatToken);
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
   *
   * `clientKind` classes the paired device — `'mobile'` (the default, matching
   * every pairing minted before browser clients existed) or `'web'` for a
   * browser session. Callers at the HTTP boundary validate the two-value union
   * before reaching here; this layer just threads it through to the store.
   *
   * Task 3: when `clientKind === 'web'` AND the account has registered at
   * least one signer device, minting does NOT hand back a credential at all —
   * it returns a {@link PendingApproval} instead, and no relay credential is
   * provisioned until a signer approves (`decideApproval`). Mobile mints and
   * zero-signer accounts are completely unaffected (byte-compat pinned by
   * tests): the gate applies to `'web'` only in v1 — a mobile client signs in
   * as the account and IS itself the signer, so gating it would deadlock
   * enrolling the very first device. See
   * docs/plans/2026-08-31-signer-device-plan.md for the full design.
   */
  async createPairing(
    accountId: string,
    gatewayId: string,
    deviceLabel?: string,
    clientKind: ClientKind = 'mobile',
  ): Promise<CreatedPairing | PendingApproval> {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) {
      throw new Error(`gateway ${gatewayId} not found for account ${accountId}`);
    }
    // A browser cannot be handed the chat bearer out of band, so a web pairing
    // is only useful with one. Resolve it BEFORE minting: failing afterwards
    // would leave an orphan credential live on the relay that the caller never
    // received and cannot revoke by id.
    let chatToken: string | undefined;
    const registered = this.#store.getWebChatToken(gatewayId);
    if (clientKind === 'web') {
      if (!registered) {
        throw new WebChatTokenMissingError(`no web chat token registered for gateway ${gatewayId}`);
      }
      chatToken = registered;
    } else if (registered) {
      // Account-authenticated native clients (iOS sign-in) receive the same
      // chat-scoped token when available; absence is not an error so legacy
      // MC-driven mints for Android QR pairing keep their exact behavior.
      chatToken = registered;
    }

    if (clientKind === 'web' && this.#store.signerCount(accountId) > 0) {
      return this.#mintPendingApproval(accountId, gatewayId, deviceLabel ?? null, clientKind);
    }

    const credential = await this.#relay.provisionPairing(accountId, gatewayId);
    const pairingId = generatePairingId();
    this.#store.addPairing({
      id: pairingId,
      gatewayId,
      credentialHash: sha256(credential),
      deviceLabel: deviceLabel ?? null,
      clientKind,
    });
    return chatToken === undefined
      ? { credential, pairingId, status: 'active' }
      : { credential, pairingId, chatToken, status: 'active' };
  }

  /**
   * Persist a PENDING pairing (no credential yet) plus its approval
   * challenge, and return the mint response Task 4's web client renders as a
   * QR. Never touches the relay — see `decideApproval` for where the
   * credential is actually minted.
   */
  #mintPendingApproval(
    accountId: string,
    gatewayId: string,
    deviceLabel: string | null,
    clientKind: ClientKind,
  ): PendingApproval {
    const pairingId = generatePairingId();
    this.#store.addPairing({
      id: pairingId,
      gatewayId,
      credentialHash: '',
      deviceLabel,
      clientKind,
      status: 'pending',
    });
    const approvalId = randomBytes(16).toString('base64url');
    const approvalExpiresAt = this.#now() + this.#approvalTtlMs;
    this.#store.createApproval({
      approvalId,
      accountId,
      gatewayId,
      pairingId,
      deviceLabel,
      expiresAt: approvalExpiresAt,
    });
    return { pairingId, status: 'pending', approvalId, approvalExpiresAt };
  }

  /**
   * Fetch an approval, scoped to `accountId` — `null` if unknown OR owned by
   * another account (never disclosing which, matching every other ownership
   * check in this service). Returns the record regardless of whether it has
   * already been decided or has expired; the HTTP layer projects it as-is —
   * `decideApproval` is where "too late" is actually enforced.
   */
  getApproval(accountId: string, approvalId: string): ApprovalRecord | null {
    const approval = this.#store.getApproval(approvalId);
    if (!approval || approval.accountId !== accountId) return null;
    return approval;
  }

  /**
   * Record a signer's decision on a pending approval.
   *
   * Order of checks matters for security, not just correctness:
   *  1. Existence + account match (`ApprovalNotFoundError`, 404) — never
   *     disclose a cross-account approval id.
   *  2. Still pending AND unexpired. An expired-but-still-pending approval is
   *     swept right here (denied + its orphan pairing discarded) so no dead
   *     PENDING row survives past its TTL even without a background sweep.
   *     Either way: `ApprovalClosedError` (410).
   *  3. Signature verification — a signer that does not belong to
   *     `accountId`, OR a signature that does not verify over
   *     `approvalMessage(approvalId, pairingId, decision)`, throws
   *     `InvalidApprovalSignatureError` (403) WITHOUT marking the approval
   *     decided. A forged/garbage attempt must not be able to burn a
   *     legitimate approval out from under the real signer.
   *  4. Only once signed off does the transition to `'approved'`/`'denied'`
   *     happen — atomically, via the store's `WHERE status = 'pending'`
   *     guard, which is the actual race-closing single-decision enforcement
   *     (step 2's read is just an optimization/early-exit).
   *
   * On approval: mints the relay credential now (not at initial mint time —
   * see the class-level Task 3 note on `createPairing`), flips the pairing to
   * `'active'`, and stores the raw credential (+ the gateway's registered
   * chat token) as a value awaiting exactly one claim via
   * {@link claimCredential}. On denial: the pending pairing row is hard-deleted
   * — there was never a live device to keep a record of.
   */
  async decideApproval(
    accountId: string,
    approvalId: string,
    opts: { decision: ApprovalDecision; signerId: string; signature: string },
  ): Promise<void> {
    const approval = this.#store.getApproval(approvalId);
    if (!approval || approval.accountId !== accountId) {
      throw new ApprovalNotFoundError(`approval ${approvalId} not found for account ${accountId}`);
    }

    const expired = approval.expiresAt <= this.#now();
    if (approval.status !== 'pending' || expired) {
      if (
        approval.status === 'pending' &&
        expired &&
        this.#store.decideApproval(approvalId, 'denied')
      ) {
        this.#store.discardPendingPairing(approval.gatewayId, approval.pairingId);
      }
      throw new ApprovalClosedError(`approval ${approvalId} is expired or already decided`);
    }

    const signer = this.#store.signerByAccountAndId(accountId, opts.signerId);
    const key = signer ? rawEd25519ToKeyObject(signer.publicKey) : null;
    const message = approvalMessage(approvalId, approval.pairingId, opts.decision);
    const ok = key !== null && safeVerify(message, opts.signature, key);
    if (!ok) {
      throw new InvalidApprovalSignatureError(`invalid signature for approval ${approvalId}`);
    }

    // Atomic pending -> decided transition. Loses a same-instant race to a
    // second decision request (including a concurrent expiry sweep above).
    const decided = this.#store.decideApproval(
      approvalId,
      opts.decision === 'approve' ? 'approved' : 'denied',
    );
    if (!decided) {
      throw new ApprovalClosedError(`approval ${approvalId} is expired or already decided`);
    }

    if (opts.decision === 'deny') {
      this.#store.discardPendingPairing(approval.gatewayId, approval.pairingId);
      return;
    }

    const credential = await this.#relay.provisionPairing(accountId, approval.gatewayId);
    const chatToken = this.#store.getWebChatToken(approval.gatewayId);
    this.#store.activatePairing(approval.gatewayId, approval.pairingId, {
      credentialHash: sha256(credential),
      credential,
      chatToken,
    });
  }

  /**
   * Claim the single-use credential (+ chat token) an approved pairing is
   * holding. Ownership is checked via the gateway (cross-account or unknown
   * gateway/pairing → `'not-found'`). `'pending'` means the approval has not
   * been decided yet — the caller (the web app's poll loop) should keep
   * waiting, not treat it as an error. `'claimed'` means activation happened
   * but the one-time value is already gone — either a real double-claim or a
   * pairing that was never routed through the approval flow at all.
   */
  claimCredential(accountId: string, gatewayId: string, pairingId: string): ClaimResult {
    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.accountId !== accountId) return { kind: 'not-found' };
    const pairing = this.#store.listPairings(gatewayId).find((p) => p.id === pairingId);
    if (!pairing) return { kind: 'not-found' };
    if (pairing.status === 'pending') return { kind: 'pending' };
    const claimed = this.#store.claimCredential(gatewayId, pairingId);
    if (!claimed) return { kind: 'claimed' };
    return claimed.chatToken === null
      ? { kind: 'ok', credential: claimed.credential }
      : { kind: 'ok', credential: claimed.credential, chatToken: claimed.chatToken };
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

  /**
   * Register a signer device's public key for `accountId`. Idempotent per
   * `(accountId, publicKey)` — a matching prior registration keeps its
   * `signerId` and just refreshes `label`, matching the store's upsert.
   * Throws `InvalidPublicKeyError` (nothing persisted) when `publicKey` does
   * not decode to exactly 32 raw Ed25519 bytes in canonical unpadded
   * base64url — the same form the relay's `cnf`/JWK convention requires (see
   * `apps/relay/src/assertion.ts`).
   */
  registerSigner(accountId: string, opts: { publicKey: string; label: string }): SignerRecord {
    if (!isValidEd25519PublicKey(opts.publicKey)) {
      throw new InvalidPublicKeyError(`invalid signer public key: ${opts.publicKey}`);
    }
    this.#store.createAccount(accountId);
    return this.#store.addSigner({
      accountId,
      publicKey: opts.publicKey,
      label: opts.label,
    });
  }

  /** List the signers registered for `accountId`. */
  listSigners(accountId: string): SignerRecord[] {
    return this.#store.listSigners(accountId);
  }
}

/**
 * True iff `key` is a canonical, unpadded base64url encoding of exactly 32
 * raw bytes (a raw Ed25519 public key). Re-encoding and comparing catches
 * padded (`=`), standard-alphabet (`+`/`/`), or otherwise non-canonical
 * strings that `Buffer.from` would otherwise decode leniently — the wire
 * format must match exactly what `apps/relay/src/assertion.ts`'s JWK `x`
 * convention expects.
 */
function isValidEd25519PublicKey(key: string): boolean {
  try {
    const decoded = Buffer.from(key, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === key;
  } catch {
    return false;
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
