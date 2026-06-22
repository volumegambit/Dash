# Dash Android Phase 1B — Cloudflare Relay (Worker + Durable Object) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build `apps/relay` — a Cloudflare Worker plus one `RelayLink` Durable Object per `linkId` — that pipes opaque end-to-end-encrypted ciphertext between a Dash gateway and a paired phone, using the FROZEN `@dash/relay-protocol` control-plane signaling (relay-join challenge/response) verbatim, while never decrypting a single byte.

**Architecture:** A stateless Worker validates the WebSocket upgrade, the 32-char base64url `linkId`, and a per-IP connect rate limit, then routes to `env.LINK.getByName(linkId)`. The `RelayLink` Durable Object (SQLite-backed, WebSocket Hibernation API) holds a two-slot model (`gateway` + `phone`), runs the frozen single-use challenge → `slotAuthProof` → commitment-verify slot-auth, and forwards every binary data-plane record (leading byte `0x01`) byte-for-byte to the opposite slot. Control messages (leading byte `0x80`–`0x83`) are consumed by the DO; the E2E handshake (opcodes `0x90`–`0x92` inside `0x04` data frames) is opaque to the relay.

**Tech Stack:** Node.js 22 toolchain at the repo root (ESM, TypeScript strict, ES2024/NodeNext, Biome 2-space/single-quote/semicolons/100-col, Vitest globals). The relay itself targets Cloudflare Workers (`workerd`) via `wrangler@4.103.0`, tested with `@cloudflare/vitest-pool-workers@0.8.71` (the vitest-3-compatible line: peer `vitest 2.0.x - 3.2.x`, exports `./config` with `defineWorkersProject` + `poolOptions.workers`). The DO uses SQLite storage (`new_sqlite_classes`), `ctx.acceptWebSocket` hibernation, `setWebSocketAutoResponse`, and `ctx.storage.setAlarm`. The only runtime dependency is `@dash/relay-protocol` (Unit A, FROZEN), imported for the control-plane codec (`encodeChallenge`/`decodeJoin`/`encodeJoinResult`/…), the slot-auth crypto (`slotAuthProof`/`slotSecretCommitment`), `bytesEqual`, `randomBytes16`, and `MAX_WS_MESSAGE`. The relay imports `node:crypto` only transitively through that package (available in `workerd` via `nodejs_compat`).

---

## Prerequisites & Frozen Contract (read before Task 1)

This plan is **Unit B** of four sequential units. **Unit A (`packages/relay-protocol`) is already implemented and FROZEN.** Every wire/crypto detail this plan touches comes from `@dash/relay-protocol`'s public API — do NOT reinvent any of it. The bare import specifier is exactly `@dash/relay-protocol` (the package's `name` field). **NEVER write `@relay-protocol`.**

The exports this unit consumes (all verbatim from the frozen contract):

**Control plane (`control.ts`) — relay-join signaling:**
```ts
// Discriminators on the leading wire byte. 0x80–0x83 distinguish a control
// message from a data-plane AEAD record (whose leading byte is protoVer = 0x01).
export const ControlMsgType: {
  readonly JOIN: 0x80; readonly CHALLENGE: 0x81;
  readonly SLOT_AUTH: 0x82; readonly JOIN_RESULT: 0x83;
};
export const Role: { readonly GATEWAY: 0x01; readonly PHONE: 0x02 };
export type Role = (typeof Role)[keyof typeof Role];
export const JoinResultCode: {
  readonly OK: 0x00; readonly SLOT_TAKEN: 0x01; readonly BAD_PROOF: 0x02;
  readonly NO_PENDING_LINK: 0x03; readonly RATE_LIMITED: 0x04; readonly UNLINKED: 0x05;
};
export type JoinResultCode = (typeof JoinResultCode)[keyof typeof JoinResultCode];

export interface JoinMessage { role: Role; linkId: string; }
export interface SlotAuthMessage { role: Role; slotProof: Uint8Array; slotSecretHash: Uint8Array; }
export interface JoinResultMessage { code: JoinResultCode; peerPresent: boolean; }

export function peekControlMsgType(bytes: Uint8Array): number; // throws 'empty control message'

// JOIN        [0x80][role:1][linkIdLen:2 BE][linkId:ascii]
export function encodeJoin(msg: JoinMessage): Uint8Array;
export function decodeJoin(bytes: Uint8Array): JoinMessage; // throws 'JOIN too short' | 'not a JOIN message' | 'JOIN length mismatch'
// CHALLENGE   [0x81][challenge:16]
export function encodeChallenge(challenge: Uint8Array): Uint8Array; // throws 'challenge must be 16 bytes'
export function decodeChallenge(bytes: Uint8Array): Uint8Array;     // throws 'not a CHALLENGE message' | 'CHALLENGE length mismatch'
// SLOT_AUTH   [0x82][role:1][slotProof:32][slotSecretHash:32]
export function encodeSlotAuth(msg: SlotAuthMessage): Uint8Array;
export function decodeSlotAuth(bytes: Uint8Array): SlotAuthMessage; // throws 'not a SLOT_AUTH message' | 'SLOT_AUTH length mismatch'
// JOIN_RESULT [0x83][code:1][peerPresent:1]
export function encodeJoinResult(msg: JoinResultMessage): Uint8Array;
export function decodeJoinResult(bytes: Uint8Array): JoinResultMessage; // throws 'not a JOIN_RESULT message' | 'JOIN_RESULT length mismatch'
```

**Handshake/slot-auth crypto (`handshake.ts`):**
```ts
export const SLOT_AUTH_PREFIX = 'dash-slot-v1';
// slotSecretHash = SHA-256(slotSecret)
export function slotSecretCommitment(slotSecret: Uint8Array): Uint8Array;
// slotProof = HMAC(slotSecret, "dash-slot-v1" ‖ challenge)
export function slotAuthProof(slotSecret: Uint8Array, challenge: Uint8Array): Uint8Array;
```

**Bytes/crypto helpers (`bytes.ts` / `crypto.ts`):**
```ts
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean; // constant-time; false on length mismatch
export function toBase64Url(bytes: Uint8Array): string;
export function fromBase64Url(s: string): Uint8Array;
export function randomBytes16(): Uint8Array; // 16B CSPRNG
export function sha256(data: Uint8Array): Uint8Array;
```

**Frame constants (`frame.ts`):**
```ts
export const PROTO_VER = 1;          // leading byte of every data-plane record
export const MAX_WS_MESSAGE = 33554432; // 32 MiB
```

### THE CONTROL-PLANE PROTOCOL THIS RELAY SPEAKS (canonical — do not deviate)

The relay implements EXACTLY this handshake on each WebSocket, using only the frozen codec above. There is ONE construction, used identically for gateway and phone:

1. **Client → relay (`JOIN`, `0x80`):** `{ role, linkId }`. `role` is `Role.GATEWAY` or `Role.PHONE`. The DO derives create-vs-join from whether a `LinkRecord` already exists:
   - `GATEWAY` + no record → **create** the link (`pending`), arm `PENDING_TTL`.
   - `GATEWAY` + record exists → **reconnect** (re-challenge the gateway slot).
   - `PHONE` + no record → reject with `JOIN_RESULT{ code: NO_PENDING_LINK }` then close.
   - `PHONE` + record exists → **join** (challenge the phone slot).
2. **Relay → client (`CHALLENGE`, `0x81`):** a fresh 16-byte CSPRNG `challenge` (`randomBytes16()`), unique per (re)connect, stored single-use in the socket attachment.
3. **Client → relay (`SLOT_AUTH`, `0x82`):** `{ role, slotProof, slotSecretHash }` where the client computed `slotProof = slotAuthProof(slotSecret, challenge)` and `slotSecretHash = slotSecretCommitment(slotSecret)`. The relay verifies exactly three things (it is zero-knowledge of `slotSecret`, so it does NOT and CANNOT recompute the proof — see the note below):
   - **Outstanding challenge:** a fresh single-use `challenge` was issued to this socket and not yet consumed (else close `4400`). This binds the auth to THIS connection and makes a captured URL non-replayable.
   - **Shape:** `slotProof` is exactly 32 bytes and `slotSecretHash` is exactly 32 bytes (the frozen codec already guarantees this; the relay re-asserts it; else `JOIN_RESULT{ BAD_PROOF }` + close `4401`).
   - **Commitment continuity:** on the first auth for a role, store `slotSecretHash` in the `LinkRecord`; on every subsequent (re)connect the presented `slotSecretHash` MUST `bytesEqual` the stored one, else `JOIN_RESULT{ BAD_PROOF }` + close `4401` (a different device cannot silently take over a slot).

   On all three passing, the relay consumes the challenge (single-use), marks the socket authed, and replies `JOIN_RESULT{ OK, peerPresent }`. This is anti-DoS + replay-resistance only, exactly as the spec scopes slot-auth ("single-use challenge-response anti-DoS hint that never authorizes the E2E peer").

   > **IMPORTANT cryptographic note (read once, internalize for every slot-auth task).** The frozen `slotAuthProof(slotSecret, challenge) = HMAC(slotSecret, "dash-slot-v1" ‖ challenge)` is keyed by the *secret*, and `slotSecretCommitment(slotSecret) = SHA-256(slotSecret)`. The relay is **zero-knowledge of `slotSecret`** — it stores only `slotSecretHash`. So the relay CANNOT recompute `slotAuthProof` to byte-compare. The relay's verifiable invariants are exactly: the presented `slotSecretHash` is a 32-byte value that (after first use) never changes for a role, AND a fresh 32-byte `slotProof` accompanies it that is bound to the relay's just-issued single-use `challenge`. The cryptographic authorization of the *peer* is the gateway's E2E handshake (Unit C), not the relay. This plan therefore implements slot-auth as **commitment-continuity + single-use-challenge liveness**, which is precisely the spec's "single-use challenge-response anti-DoS hint that never authorizes the E2E peer." Do NOT invent a scheme where the relay knows `slotSecret`; do NOT change the frozen proof construction.
4. **Relay → client (`JOIN_RESULT`, `0x83`):** `{ code, peerPresent }`.
   - `code = OK` and the socket becomes **authed** (may now forward data). `peerPresent` = is the opposite slot currently authed.
   - On any failure: send `JOIN_RESULT` with the matching code (`SLOT_TAKEN` / `BAD_PROOF` / `NO_PENDING_LINK` / `RATE_LIMITED` / `UNLINKED`) then close with the matching WS close code.
5. **After both slots are authed:** the DO sends each side a `JOIN_RESULT{ code: OK, peerPresent: true }` peer-online nudge when the *second* slot authes, and forwards data-plane records verbatim.

### Routing rule (the single most important relay invariant)

For every inbound **binary** WS message, route by the leading byte using `peekControlMsgType` defensively:
- leading byte `0x01` (`PROTO_VER`) ⇒ **data-plane AEAD record** ⇒ forward verbatim to the peer slot (after auth + rate/backpressure gates). The relay NEVER decodes, decrypts, chunks, or reassembles it.
- leading byte `0x80`–`0x83` ⇒ **relay-join control message** ⇒ consume in the DO (Tasks 30–37).
- anything else ⇒ protocol error ⇒ close `4400`.

Text WS messages are never expected; the relay closes `4400` on any text frame.

### Build/run/test cheatsheet (used throughout)

- Build Unit A first (this package depends on it): `npm run build -w packages/relay-protocol`.
- Run the whole relay suite: `npm test --workspace=apps/relay`.
- Run one relay test file: `npm test --workspace=apps/relay -- <substring>` (e.g. `-- token-bucket`).
- Lint the relay: `npx biome check apps/relay/src apps/relay/test`.
- Root suite (must stay green, must NOT collect relay tests): `npm test`.

---

## File Structure

```
apps/relay/
  package.json                 # @dash/relay workspace manifest (wrangler + workers-pool deps)
  tsconfig.json                # worker TS config (bundler resolution, workers types)
  .gitignore                   # dist/, .wrangler/, worker-configuration.d.ts
  wrangler.jsonc               # RelayLink DO binding, new_sqlite_classes migration, dev/prod envs, custom domain
  worker-configuration.d.ts    # generated by `wrangler types` (gitignored)
  vitest.config.ts             # defineWorkersProject (workers pool)
  README.md                    # deployer instructions
  src/
    index.ts                   # stateless Worker shim + RelayLink re-export
    relay-link.ts              # RelayLink DO: upgrade, slot model, control-plane handshake, forwarding, TTL, teardown
    protocol.ts                # relay-local constants (close codes, roles, TTLs, limits) + MAX_WS_MESSAGE re-export
    link-id.ts                 # linkId shape validation + URL extraction
    ip-rate-limit.ts           # per-IP fixed-window connect limiter (Worker)
    token-bucket.ts            # per-link frame-rate token bucket (DO)
  test/
    protocol.test.ts
    link-id.test.ts
    ip-rate-limit.test.ts
    token-bucket.test.ts
    smoke.test.ts
    link-record.test.ts
    ws-join-gateway.test.ts
    ws-join-phone.test.ts
    ws-forward.test.ts
    ttl.test.ts
    lifecycle.test.ts
    reconnect.test.ts
    peer-offline.test.ts
    worker.test.ts
    hibernation.test.ts
```

Root files modified: `package.json` (workspace already globs `apps/*`; add `test:relay` script + ensure relay excluded from root build), `vitest.config.ts` (exclude `apps/relay/**` from the root forks pool).

---

## Part B — `apps/relay` (the zero-knowledge ciphertext pipe)

> **Dependency note:** this package imports `@dash/relay-protocol` (Unit A, FROZEN). Before the first task that imports it (Task 4 onward), Unit A must be built: `npm run build -w packages/relay-protocol`. Tasks 1–3 have no such dependency.

---

### Task 1: Scaffold the `apps/relay` workspace package

**Files:** Create `apps/relay/package.json`, Create `apps/relay/tsconfig.json`, Create `apps/relay/.gitignore`

- [ ] **Step 1: Create `apps/relay/package.json`**

```json
{
  "name": "@dash/relay",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "deploy:prod": "wrangler deploy --env production",
    "dev": "wrangler dev",
    "cf-types": "wrangler types",
    "test": "vitest run"
  },
  "dependencies": {
    "@dash/relay-protocol": "*"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.8.71",
    "wrangler": "4.103.0"
  }
}
```

> `@cloudflare/vitest-pool-workers@0.8.71` is the latest of the 0.8 line; its peer range is `vitest 2.0.x - 3.2.x`, which matches the repo's root `vitest@^3`. (The newer 0.16 line requires `vitest ^4` and would break the root suite.) It exports `./config` with `defineWorkersProject`.

- [ ] **Step 2: Create `apps/relay/tsconfig.json`** (worker source uses bundler resolution + workers types)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "moduleResolution": "bundler",
    "module": "ESNext",
    "lib": ["ES2024"],
    "types": ["@cloudflare/vitest-pool-workers/types", "./worker-configuration.d.ts"],
    "noEmit": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src", "test", "worker-configuration.d.ts"]
}
```

- [ ] **Step 3: Create `apps/relay/.gitignore`**

```
dist/
.wrangler/
worker-configuration.d.ts
```

> `worker-configuration.d.ts` is generated by `wrangler types` (Task 2 Step 4); it is gitignored but referenced in tsconfig.

- [ ] **Step 4: Install the pinned dev deps and link the workspace**

Run:
```bash
npm install --workspace=apps/relay @cloudflare/vitest-pool-workers@0.8.71 wrangler@4.103.0
```
Expected: completes; `package-lock.json` updated. A peer-dep note that `0.8.71` wants `vitest 2.0.x - 3.2.x` is SATISFIED by the root's `vitest@^3` — proceed. (If npm errors with `ERESOLVE`, re-run with `--workspace=apps/relay` only and confirm the root `vitest` is in the 3.x range.)

- [ ] **Step 5: Commit**

```bash
git add apps/relay/package.json apps/relay/tsconfig.json apps/relay/.gitignore package-lock.json
git commit -m "relay: scaffold apps/relay workspace package"
```

---

### Task 2: wrangler.jsonc + Worker entry skeleton + generated types

**Files:** Create `apps/relay/wrangler.jsonc`, Create `apps/relay/src/index.ts`, Create `apps/relay/src/relay-link.ts`, Generate `apps/relay/worker-configuration.d.ts`

- [ ] **Step 1: Create `apps/relay/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "dash-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-17",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "durable_objects": {
    "bindings": [{ "name": "LINK", "class_name": "RelayLink" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RelayLink"] }],
  "env": {
    "dev": {
      "name": "dash-relay-dev"
    },
    "production": {
      "name": "dash-relay-prod",
      "routes": [{ "pattern": "relay.dash.example.com", "custom_domain": true }]
    }
  }
}
```

> Notes: `nodejs_compat` makes `node:crypto` available in `workerd` — required because `@dash/relay-protocol` (the slot-auth + bytes helpers we import) is built on Node built-ins. `new_sqlite_classes` makes the DO SQLite-backed (free-tier eligible, required by the spec). The `production` route is a **custom domain** (NOT `workers.dev`), per spec; `relay.dash.example.com` is a placeholder the deployer edits at deploy time.

- [ ] **Step 2: Create `apps/relay/src/index.ts`** (minimal: re-export the DO + a 200 default fetch; fleshed out in Task 38)

```ts
import { RelayLink } from './relay-link.js';

export { RelayLink };

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('dash-relay', { status: 200 });
  },
};
```

- [ ] **Step 3: Create a placeholder `apps/relay/src/relay-link.ts`** so the export resolves (replaced in Task 6)

```ts
import { DurableObject } from 'cloudflare:workers';

export class RelayLink extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
```

- [ ] **Step 4: Generate the binding types** so `Env` is known to TS

Run:
```bash
npm run cf-types --workspace=apps/relay
```
Expected: writes `apps/relay/worker-configuration.d.ts` declaring `interface Env { LINK: DurableObjectNamespace<RelayLink>; }`. Verify:
```bash
test -f apps/relay/worker-configuration.d.ts && echo OK
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/wrangler.jsonc apps/relay/src/index.ts apps/relay/src/relay-link.ts
git commit -m "relay: add wrangler.jsonc, worker entry, RelayLink DO skeleton"
```

---

### Task 3: Vitest workers-pool config + exclude relay from root config

**Files:** Create `apps/relay/vitest.config.ts`, Create `apps/relay/test/smoke.test.ts`, Modify `vitest.config.ts` (root), Modify `package.json` (root)

- [ ] **Step 1: Create `apps/relay/vitest.config.ts`** (0.8.x form: `defineWorkersProject` + `poolOptions.workers`)

```ts
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersProject({
  test: {
    name: 'relay',
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
```

> `singleWorker: true` runs every test file in one shared `workerd` isolate — important because our DO tests create many short-lived links and we want module-scope Worker state (the IP limiter) to behave like production. `wrangler.configPath` makes the pool read `main`, the DO binding, the `nodejs_compat` flag, and the `new_sqlite_classes` migration straight from `wrangler.jsonc`.

- [ ] **Step 2: Exclude relay tests from the root (forks-pool) config.** Open the repo-root `vitest.config.ts`. The current `include` line (root file line 19) is:
```ts
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
```
Add an `exclude` immediately after it so the root never collects relay tests (the relay's tests live under `apps/relay/test/`, not `apps/relay/src/`, but we exclude the whole dir for safety):
```ts
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'apps/relay/**'],
```

- [ ] **Step 3: Create the smoke test.** Create `apps/relay/test/smoke.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { it } from 'vitest';

it('binds the LINK durable object namespace', async ({ expect }) => {
  expect(env.LINK).toBeDefined();
  const id = env.LINK.idFromName('smoke');
  expect(id.toString()).toMatch(/^[0-9a-f]+$/);
});
```

- [ ] **Step 4: Add the root convenience script.** In the repo-root `package.json` `scripts` block, add a line immediately after the existing `"test": "vitest run",` line:
```json
    "test:relay": "npm test --workspace=apps/relay",
```

- [ ] **Step 5: Run the relay suite to verify the pool boots**

Run:
```bash
npm test --workspace=apps/relay
```
Expected: PASS — `1 passed`. This proves `defineWorkersProject`, the wrangler config, the DO binding, and the `workerd` pool all load. (If it fails with `Cannot find module '@cloudflare/vitest-pool-workers/config'`, the dep didn't install — re-run Task 1 Step 4.)

- [ ] **Step 6: Run the root suite to confirm the relay is excluded**

Run:
```bash
npm test 2>&1 | tail -5
```
Expected: PASS — root tests run as before; no `apps/relay` test is collected.

- [ ] **Step 7: Commit**

```bash
git add apps/relay/vitest.config.ts apps/relay/test/smoke.test.ts vitest.config.ts package.json
git commit -m "relay: workers-pool vitest config; exclude relay from root; add test:relay script"
```

---

### Task 4: Protocol constants module (`src/protocol.ts`)

**Files:** Create `apps/relay/src/protocol.ts`, Create `apps/relay/test/protocol.test.ts`

> Requires Unit A built. Run `npm run build -w packages/relay-protocol` first if you have not this session.

This module holds the relay-local constants (WS close codes, slot roles, timing, limits) and the one re-export from `@dash/relay-protocol`.

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/protocol.test.ts`:

```ts
import { it } from 'vitest';
import {
  CEILING_BYTES,
  CloseCode,
  HIGH_WATER_BYTES,
  IDLE_TTL_MS,
  LINK_ID_LEN,
  PENDING_TTL_MS,
  RELAY_MAX_WS_MESSAGE,
  RelayRole,
  TOKEN_BUCKET_CAPACITY,
  TOKEN_BUCKET_REFILL_PER_SEC,
} from '../src/protocol.js';

it('defines the relay WS close codes', async ({ expect }) => {
  expect(CloseCode.NORMAL).toBe(1000);
  expect(CloseCode.POLICY_VIOLATION).toBe(1008);
  expect(CloseCode.TRY_AGAIN_LATER).toBe(1013);
  expect(CloseCode.BAD_SIGNAL).toBe(4400);
  expect(CloseCode.SLOT_AUTH_FAILED).toBe(4401);
  expect(CloseCode.NO_LINK).toBe(4404);
  expect(CloseCode.SLOT_TAKEN).toBe(4409);
  expect(CloseCode.UNLINKED).toBe(4410);
});

it('defines the two slot roles as DO socket tags', async ({ expect }) => {
  expect(RelayRole.GATEWAY).toBe('gateway');
  expect(RelayRole.PHONE).toBe('phone');
});

it('defines lifecycle timing and limits', async ({ expect }) => {
  expect(PENDING_TTL_MS).toBe(75_000);
  expect(IDLE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  expect(LINK_ID_LEN).toBe(32);
  expect(HIGH_WATER_BYTES).toBe(8 * 1024 * 1024);
  expect(CEILING_BYTES).toBe(24 * 1024 * 1024);
  expect(TOKEN_BUCKET_CAPACITY).toBe(200);
  expect(TOKEN_BUCKET_REFILL_PER_SEC).toBe(200);
});

it('re-exports the protocol max WS message size as 32 MiB', async ({ expect }) => {
  expect(RELAY_MAX_WS_MESSAGE).toBe(32 * 1024 * 1024);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- protocol
```
Expected: FAIL — `Cannot find module '../src/protocol.js'` (or `Failed to resolve import`).

- [ ] **Step 3: Write the implementation.** Create `apps/relay/src/protocol.ts`:

```ts
import { MAX_WS_MESSAGE } from '@dash/relay-protocol';

/**
 * WebSocket close codes used by the relay. Codes >= 4000 are application-defined.
 * The relay never decrypts payloads; these communicate transport-level outcomes
 * to both peers so each can render accurate UI and decide whether to retry.
 */
export const CloseCode = {
  NORMAL: 1000,
  POLICY_VIOLATION: 1008, // per-link token-bucket rate limit exceeded
  TRY_AGAIN_LATER: 1013, // per-peer backpressure ceiling exceeded
  BAD_SIGNAL: 4400, // malformed control message, text frame, or bad leading byte
  SLOT_AUTH_FAILED: 4401, // SLOT_AUTH failed (bad commitment / bad proof shape / unauthed data)
  NO_LINK: 4404, // phone tried to join a non-existent link
  SLOT_TAKEN: 4409, // role slot already held by a live authed socket (non-reconnect)
  UNLINKED: 4410, // link torn down (unlink / TTL / revocation)
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/**
 * The two — and only two — slots a link supports. Used verbatim as DO socket
 * tags via ctx.acceptWebSocket(ws, [tag]) and recovered via ctx.getTags / the
 * tag argument to ctx.getWebSockets(tag). These are RELAY-LOCAL strings; the
 * on-the-wire role is the numeric @dash/relay-protocol `Role` (0x01 / 0x02).
 */
export const RelayRole = {
  GATEWAY: 'gateway',
  PHONE: 'phone',
} as const;
export type RelayRole = (typeof RelayRole)[keyof typeof RelayRole];

/** A created-but-unpaired link self-destructs after this long (spec: 75 s). */
export const PENDING_TTL_MS = 75_000;
/** A paired-but-idle link is GC'd after this long (optional hygiene). */
export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** linkId is exactly 32 base64url characters (192 bits of CSPRNG). */
export const LINK_ID_LEN = 32;

/** Per-peer in-flight backpressure: soft signal above high-water, hard close at the ceiling. */
export const HIGH_WATER_BYTES = 8 * 1024 * 1024;
export const CEILING_BYTES = 24 * 1024 * 1024;

/** Per-link frame-rate token bucket (~200 data frames/s sustained). */
export const TOKEN_BUCKET_CAPACITY = 200;
export const TOKEN_BUCKET_REFILL_PER_SEC = 200;

/** Hard cap on a single WS binary message; mirrors the frozen protocol contract (32 MiB). */
export const RELAY_MAX_WS_MESSAGE = MAX_WS_MESSAGE;
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- protocol
```
Expected: PASS — `4 passed`.

> If this FAILS with `Cannot find module '@dash/relay-protocol'`, Unit A is not built/linked. Run `npm run build -w packages/relay-protocol` then re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/protocol.ts apps/relay/test/protocol.test.ts
git commit -m "relay: protocol constants (close codes, roles, limits, TTLs)"
```

---

### Task 5: linkId validation helper (`src/link-id.ts`)

**Files:** Create `apps/relay/src/link-id.ts`, Create `apps/relay/test/link-id.test.ts`

The Worker shape-gates `linkId` before spawning a DO (cheap reject). Exactly 32 base64url chars `[A-Za-z0-9_-]`.

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/link-id.test.ts`:

```ts
import { it } from 'vitest';
import { extractLinkId, isValidLinkId } from '../src/link-id.js';

it('accepts exactly 32 base64url chars', async ({ expect }) => {
  expect(isValidLinkId('A'.repeat(32))).toBe(true);
  expect(isValidLinkId('aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-AB')).toBe(true);
});

it('rejects wrong length', async ({ expect }) => {
  expect(isValidLinkId('A'.repeat(31))).toBe(false);
  expect(isValidLinkId('A'.repeat(33))).toBe(false);
  expect(isValidLinkId('')).toBe(false);
});

it('rejects non-base64url characters', async ({ expect }) => {
  expect(isValidLinkId('+'.repeat(32))).toBe(false); // + is base64, not base64url
  expect(isValidLinkId('/'.repeat(32))).toBe(false);
  expect(isValidLinkId('='.repeat(32))).toBe(false); // padding not allowed
  expect(isValidLinkId(`${'A'.repeat(31)} `)).toBe(false); // trailing space
});

it('extracts linkId from the request URL query', async ({ expect }) => {
  const id = 'b'.repeat(32);
  const req = new Request(`https://relay.example.com/connect?linkId=${id}&role=phone`);
  expect(extractLinkId(req)).toBe(id);
});

it('returns null when the linkId query is missing', async ({ expect }) => {
  const req = new Request('https://relay.example.com/connect?role=phone');
  expect(extractLinkId(req)).toBe(null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- link-id
```
Expected: FAIL — `Cannot find module '../src/link-id.js'`.

- [ ] **Step 3: Write the implementation.** Create `apps/relay/src/link-id.ts`:

```ts
import { LINK_ID_LEN } from './protocol.js';

const LINK_ID_RE = new RegExp(`^[A-Za-z0-9_-]{${LINK_ID_LEN}}$`);

/** True iff `s` is exactly LINK_ID_LEN base64url chars (no padding, no +/). */
export function isValidLinkId(s: string): boolean {
  return LINK_ID_RE.test(s);
}

/** Pull the `linkId` query param from a request URL, or null if absent. */
export function extractLinkId(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get('linkId');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- link-id
```
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/link-id.ts apps/relay/test/link-id.test.ts
git commit -m "relay: linkId shape validation + URL extraction"
```

---

### Task 6: Per-IP connect rate limiter (`src/ip-rate-limit.ts`)

**Files:** Create `apps/relay/src/ip-rate-limit.ts`, Create `apps/relay/test/ip-rate-limit.test.ts`

A small in-memory fixed-window limiter keyed by client IP, used by the stateless Worker. Per-CF-location and approximate (documented residual risk); WAF + per-DO caps backstop it.

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/ip-rate-limit.test.ts`:

```ts
import { it } from 'vitest';
import { IpRateLimiter } from '../src/ip-rate-limit.js';

it('allows up to `limit` connects within the window', async ({ expect }) => {
  const rl = new IpRateLimiter({ limit: 3, windowMs: 60_000 });
  const now = 1_000_000;
  expect(rl.allow('1.2.3.4', now)).toBe(true);
  expect(rl.allow('1.2.3.4', now)).toBe(true);
  expect(rl.allow('1.2.3.4', now)).toBe(true);
  expect(rl.allow('1.2.3.4', now)).toBe(false); // 4th in window -> blocked
});

it('tracks IPs independently', async ({ expect }) => {
  const rl = new IpRateLimiter({ limit: 1, windowMs: 60_000 });
  const now = 1_000_000;
  expect(rl.allow('1.1.1.1', now)).toBe(true);
  expect(rl.allow('2.2.2.2', now)).toBe(true);
  expect(rl.allow('1.1.1.1', now)).toBe(false);
});

it('resets after the window elapses', async ({ expect }) => {
  const rl = new IpRateLimiter({ limit: 1, windowMs: 60_000 });
  expect(rl.allow('9.9.9.9', 1_000_000)).toBe(true);
  expect(rl.allow('9.9.9.9', 1_000_000)).toBe(false);
  expect(rl.allow('9.9.9.9', 1_060_001)).toBe(true); // new window
});

it('treats a null/unknown IP as a single shared bucket', async ({ expect }) => {
  const rl = new IpRateLimiter({ limit: 1, windowMs: 60_000 });
  expect(rl.allow(null, 1_000_000)).toBe(true);
  expect(rl.allow(null, 1_000_000)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- ip-rate-limit
```
Expected: FAIL — `Cannot find module '../src/ip-rate-limit.js'`.

- [ ] **Step 3: Write the implementation.** Create `apps/relay/src/ip-rate-limit.ts`:

```ts
interface WindowState {
  count: number;
  resetAt: number; // epoch ms when the current window ends
}

export interface IpRateLimiterOptions {
  limit: number; // max connects per window
  windowMs: number; // window length in ms
}

/**
 * Fixed-window per-IP connect limiter. In-memory in the stateless Worker, so it
 * is per-CF-location and approximate (documented residual risk). Backstopped by
 * the WAF and per-DO caps. A `null` IP collapses to one shared bucket key.
 */
export class IpRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, WindowState>();

  constructor(opts: IpRateLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
  }

  /** Record one connect attempt; return true if allowed, false if over the limit. */
  allow(ip: string | null, now: number = Date.now()): boolean {
    const key = ip ?? '__unknown__';
    const win = this.windows.get(key);
    if (win === undefined || now >= win.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (win.count >= this.limit) return false;
    win.count += 1;
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- ip-rate-limit
```
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/ip-rate-limit.ts apps/relay/test/ip-rate-limit.test.ts
git commit -m "relay: per-IP fixed-window connect rate limiter"
```

---

### Task 7: Per-link frame-rate token bucket (`src/token-bucket.ts`)

**Files:** Create `apps/relay/src/token-bucket.ts`, Create `apps/relay/test/token-bucket.test.ts`

The DO uses one token bucket per link to throttle data-frame floods (~200 frames/s). Control messages bypass it (enforced by the caller in Task 8, not here).

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/token-bucket.test.ts`:

```ts
import { it } from 'vitest';
import { TokenBucket } from '../src/token-bucket.js';

it('starts full and lets a burst through up to capacity', async ({ expect }) => {
  const tb = new TokenBucket({ capacity: 5, refillPerSec: 5 }, 1_000_000);
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) expect(tb.tryRemove(t)).toBe(true);
  expect(tb.tryRemove(t)).toBe(false); // bucket empty
});

it('refills over time at refillPerSec', async ({ expect }) => {
  const tb = new TokenBucket({ capacity: 5, refillPerSec: 5 }, 1_000_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) tb.tryRemove(t0); // drain
  expect(tb.tryRemove(t0)).toBe(false);
  // 200ms later at 5/sec -> 1 token refilled
  expect(tb.tryRemove(t0 + 200)).toBe(true);
  expect(tb.tryRemove(t0 + 200)).toBe(false);
});

it('never refills beyond capacity', async ({ expect }) => {
  const tb = new TokenBucket({ capacity: 3, refillPerSec: 100 }, 1_000_000);
  const t0 = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    if (tb.tryRemove(t0 + 10_000)) allowed++;
  }
  expect(allowed).toBe(3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- token-bucket
```
Expected: FAIL — `Cannot find module '../src/token-bucket.js'`.

- [ ] **Step 3: Write the implementation.** Create `apps/relay/src/token-bucket.ts`:

```ts
export interface TokenBucketOptions {
  capacity: number; // max tokens (burst size)
  refillPerSec: number; // sustained rate
}

/**
 * Classic token bucket. Tokens refill continuously based on elapsed wall-clock
 * time; `tryRemove` consumes one token if available. Used per-link to cap the
 * data-frame forwarding rate. Time is injected (epoch ms) for deterministic tests.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(opts: TokenBucketOptions, now: number = Date.now()) {
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSec / 1000;
    this.tokens = opts.capacity;
    this.lastRefill = now;
  }

  private refill(now: number): void {
    if (now <= this.lastRefill) return;
    const added = (now - this.lastRefill) * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }

  /** Consume one token; return true if it was available, false otherwise. */
  tryRemove(now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- token-bucket
```
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/token-bucket.ts apps/relay/test/token-bucket.test.ts
git commit -m "relay: per-link frame-rate token bucket"
```

---

### Task 8: LinkRecord SQLite storage + gateway-create (`debug` RPCs)

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/link-record.test.ts`

The DO persists authoritative state in `ctx.storage.sql` (survives hibernation). One row per link. We start with the schema + private `getRecord`/`createLink` and two test-only RPCs (`debugCreateLink`, `debugGetRecord`) so the storage layer is provable in isolation before any WebSocket plumbing.

> **LinkRecord shape** (relay-local; never sent to a peer): `linkId`, `state` (`'pending' | 'paired'`), `createdAt`, `gwSlotSecretHash` (hex of the gateway's `slotSecretCommitment`, or null until first gateway auth), `phSlotSecretHash` (hex, null until first phone auth), `pairedAt` (null until paired). We store the commitment as lowercase hex for simple `bytesEqual`-after-decode comparison.

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/link-record.test.ts`:

```ts
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import type { RelayLink } from '../src/relay-link.js';

function freshStub() {
  const id = env.LINK.idFromName(`rec-${crypto.randomUUID()}`);
  return env.LINK.get(id);
}

it('createLink writes a pending LinkRecord (first-writer-wins)', async ({ expect }) => {
  const stub = freshStub();
  const result = await stub.debugCreateLink();
  expect(result.ok).toBe(true);

  await runInDurableObject(stub, async (_instance: RelayLink, state) => {
    const row = state.storage.sql
      .exec<{ state: string; gwSlotSecretHash: string | null; phSlotSecretHash: string | null }>(
        'SELECT state, gwSlotSecretHash, phSlotSecretHash FROM link LIMIT 1',
      )
      .one();
    expect(row.state).toBe('pending');
    expect(row.gwSlotSecretHash).toBe(null);
    expect(row.phSlotSecretHash).toBe(null);
  });
});

it('a second createLink is rejected (link already exists)', async ({ expect }) => {
  const stub = freshStub();
  expect((await stub.debugCreateLink()).ok).toBe(true);
  const second = await stub.debugCreateLink();
  expect(second.ok).toBe(false);
  expect(second.reason).toBe('exists');
});

it('debugGetRecord returns null before create', async ({ expect }) => {
  const stub = freshStub();
  expect(await stub.debugGetRecord()).toBe(null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- link-record
```
Expected: FAIL — `instance.debugCreateLink is not a function` (the placeholder DO has no such method).

- [ ] **Step 3: Write the implementation.** Replace the entire contents of `apps/relay/src/relay-link.ts` with:

```ts
import { DurableObject } from 'cloudflare:workers';

export type LinkState = 'pending' | 'paired';

export interface LinkRecord {
  linkId: string;
  state: LinkState;
  createdAt: number;
  gwSlotSecretHash: string | null; // hex slotSecretCommitment(gwSlotSecret), null until first gw auth
  phSlotSecretHash: string | null; // hex slotSecretCommitment(phSlotSecret), null until first phone auth
  pairedAt: number | null;
}

export interface CreateResult {
  ok: boolean;
  reason?: 'exists';
}

export class RelayLink extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Initialize the single-row schema synchronously, blocking concurrent
    // requests until storage is ready (the recommended DO pattern).
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS link (
           linkId TEXT PRIMARY KEY,
           state TEXT NOT NULL,
           createdAt INTEGER NOT NULL,
           gwSlotSecretHash TEXT,
           phSlotSecretHash TEXT,
           pairedAt INTEGER
         )`,
      );
    });
  }

  /** Read the single LinkRecord row, or null if this link was never created. */
  protected getRecord(): LinkRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{
        linkId: string;
        state: LinkState;
        createdAt: number;
        gwSlotSecretHash: string | null;
        phSlotSecretHash: string | null;
        pairedAt: number | null;
      }>('SELECT * FROM link LIMIT 1')
      .toArray();
    return rows.length === 0 ? null : rows[0];
  }

  /** Gateway-only link creation; first-writer-wins. */
  protected createLink(): CreateResult {
    if (this.getRecord() !== null) return { ok: false, reason: 'exists' };
    const linkId = this.ctx.id.name ?? this.ctx.id.toString();
    this.ctx.storage.sql.exec(
      'INSERT INTO link (linkId, state, createdAt, gwSlotSecretHash, phSlotSecretHash, pairedAt) VALUES (?, ?, ?, ?, ?, ?)',
      linkId,
      'pending',
      Date.now(),
      null,
      null,
      null,
    );
    return { ok: true };
  }

  // --- test-only RPC surface (called via stub.<method>() from vitest) ---
  // Thin wrappers exposing protected internals for unit testing without the
  // full WebSocket handshake. Safe to ship: the Worker never routes external
  // traffic to them, and they cannot mutate auth state in a way the lifecycle
  // would not.
  async debugCreateLink(): Promise<CreateResult> {
    return this.createLink();
  }

  async debugGetRecord(): Promise<LinkRecord | null> {
    return this.getRecord();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- link-record
```
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/link-record.test.ts
git commit -m "relay: LinkRecord SQLite schema + gateway-only create (first-writer-wins)"
```

---

### Task 9: DO WebSocket upgrade + gateway JOIN → CHALLENGE (frozen control plane)

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/ws-join-gateway.test.ts`

Wire the real WebSocket path using the FROZEN binary control plane. The Worker forwards an upgrade to the DO; the DO accepts a hibernatable socket tagged with the role (read from the `?role=` query param), sets the edge auto-response ping/pong, and on the first `JOIN` (`0x80`) message: for a gateway with no existing record, creates the link and replies with a `CHALLENGE` (`0x81`) carrying a fresh 16-byte `randomBytes16()` nonce stored single-use in the socket attachment.

> **Tag-at-accept constraint:** `ctx.acceptWebSocket(ws, tags)` sets tags once, at accept time, immutable thereafter. The role IS known at connect time from `?role=` (the gateway connects `role=gateway`, the phone `role=phone`), so we tag immediately. Per-socket auth state lives in `ws.serializeAttachment({ role, authed, challenge })` (survives hibernation). `challenge` is stored as a hex string (attachments must be structured-clone-serializable; hex is simplest and matches our storage convention).
>
> **Wire roles vs tags:** the `?role=` query and the DO tag use the relay-local strings `'gateway'`/`'phone'` (`RelayRole`). The `JOIN`/`SLOT_AUTH` messages carry the numeric `@dash/relay-protocol` `Role` (`0x01`/`0x02`). We require the JOIN's numeric role to match the connect-time tag role, else `4400`.

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/ws-join-gateway.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import {
  ControlMsgType,
  decodeChallenge,
  encodeJoin,
  peekControlMsgType,
  Role,
} from '@dash/relay-protocol';

function connect(linkId: string, role: 'gateway' | 'phone') {
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  return stub.fetch(`https://relay/connect?linkId=${linkId}&role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}

function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        if (e.data instanceof ArrayBuffer) resolve(new Uint8Array(e.data));
        else reject(new Error('expected binary'));
      },
      { once: true },
    );
  });
}

it('gateway JOIN elicits a CHALLENGE control message', async ({ expect }) => {
  const linkId = `g${'A'.repeat(31)}`;
  const res = await connect(linkId, 'gateway');
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  ws.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  const msg = await nextBinary(ws);
  expect(peekControlMsgType(msg)).toBe(ControlMsgType.CHALLENGE);
  const challenge = decodeChallenge(msg);
  expect(challenge.length).toBe(16);
  ws.close(1000, 'done');
});

it('rejects a missing Upgrade header with 426', async ({ expect }) => {
  const stub = env.LINK.get(env.LINK.idFromName(`u${'A'.repeat(31)}`));
  const res = await stub.fetch(`https://relay/connect?linkId=u${'A'.repeat(31)}&role=gateway`);
  expect(res.status).toBe(426);
});

it('rejects a missing role with 400', async ({ expect }) => {
  const stub = env.LINK.get(env.LINK.idFromName(`r${'A'.repeat(31)}`));
  const res = await stub.fetch(`https://relay/connect?linkId=r${'A'.repeat(31)}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(res.status).toBe(400);
});

it('closes 4400 when the JOIN role disagrees with the connect-time role', async ({ expect }) => {
  const linkId = `m${'A'.repeat(31)}`;
  const res = await connect(linkId, 'gateway');
  const ws = res.webSocket!;
  ws.accept();
  const closed = new Promise<number>((r) =>
    ws.addEventListener('close', (e) => r(e.code), { once: true }),
  );
  ws.send(encodeJoin({ role: Role.PHONE, linkId })); // wrong role for a gateway socket
  expect(await closed).toBe(4400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- ws-join-gateway
```
Expected: FAIL — the DO `fetch` still returns 501, so the upgrade never happens and `nextBinary` times out.

- [ ] **Step 3: Write the implementation.** Replace the entire contents of `apps/relay/src/relay-link.ts` with the following (extends Task 8 with the WS path + per-socket attachment + gateway JOIN→CHALLENGE). Keep the test-only RPCs.

```ts
import { DurableObject } from 'cloudflare:workers';
import {
  ControlMsgType,
  decodeJoin,
  encodeChallenge,
  type JoinMessage,
  peekControlMsgType,
  randomBytes16,
  Role,
} from '@dash/relay-protocol';
import { CloseCode, RelayRole, type RelayRole as RelayRoleT } from './protocol.js';

export type LinkState = 'pending' | 'paired';

export interface LinkRecord {
  linkId: string;
  state: LinkState;
  createdAt: number;
  gwSlotSecretHash: string | null;
  phSlotSecretHash: string | null;
  pairedAt: number | null;
}

export interface CreateResult {
  ok: boolean;
  reason?: 'exists';
}

/** Per-socket state, persisted via serializeAttachment so it survives hibernation. */
interface SocketAttachment {
  role: RelayRoleT;
  authed: boolean;
  challengeHex: string | null; // current outstanding single-use challenge (hex of 16 bytes)
}

/** Map the relay-local role string to the on-wire numeric @dash/relay-protocol Role. */
function wireRole(role: RelayRoleT): Role {
  return role === RelayRole.GATEWAY ? Role.GATEWAY : Role.PHONE;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export class RelayLink extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS link (
           linkId TEXT PRIMARY KEY,
           state TEXT NOT NULL,
           createdAt INTEGER NOT NULL,
           gwSlotSecretHash TEXT,
           phSlotSecretHash TEXT,
           pairedAt INTEGER
         )`,
      );
    });
    // Cheap edge-liveness: workerd answers 'ping' with 'pong' without waking us.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // --- storage helpers ---
  protected getRecord(): LinkRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{
        linkId: string;
        state: LinkState;
        createdAt: number;
        gwSlotSecretHash: string | null;
        phSlotSecretHash: string | null;
        pairedAt: number | null;
      }>('SELECT * FROM link LIMIT 1')
      .toArray();
    return rows.length === 0 ? null : rows[0];
  }

  protected createLink(): CreateResult {
    if (this.getRecord() !== null) return { ok: false, reason: 'exists' };
    const linkId = this.ctx.id.name ?? this.ctx.id.toString();
    this.ctx.storage.sql.exec(
      'INSERT INTO link (linkId, state, createdAt, gwSlotSecretHash, phSlotSecretHash, pairedAt) VALUES (?, ?, ?, ?, ?, ?)',
      linkId,
      'pending',
      Date.now(),
      null,
      null,
      null,
    );
    return { ok: true };
  }

  // --- socket attachment helpers ---
  private getAttachment(ws: WebSocket): SocketAttachment {
    return ws.deserializeAttachment() as SocketAttachment;
  }
  private setAttachment(ws: WebSocket, att: SocketAttachment): void {
    ws.serializeAttachment(att);
  }

  /** Issue a fresh single-use challenge to `ws` and remember it in the attachment. */
  private issueChallenge(ws: WebSocket, att: SocketAttachment): void {
    const challenge = randomBytes16();
    this.setAttachment(ws, { ...att, challengeHex: toHex(challenge) });
    ws.send(encodeChallenge(challenge));
  }

  // --- WebSocket entry point ---
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const roleParam = url.searchParams.get('role');
    if (roleParam !== RelayRole.GATEWAY && roleParam !== RelayRole.PHONE) {
      return new Response('missing or invalid role', { status: 400 });
    }
    const role: RelayRoleT = roleParam;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role]); // tag at accept-time (immutable, hibernatable)
    this.setAttachment(server, { role, authed: false, challengeHex: null });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === 'string') {
      ws.close(CloseCode.BAD_SIGNAL, 'text frames not allowed');
      return;
    }
    const bytes = new Uint8Array(message);
    let lead: number;
    try {
      lead = peekControlMsgType(bytes);
    } catch {
      ws.close(CloseCode.BAD_SIGNAL, 'empty message');
      return;
    }
    if (lead >= ControlMsgType.JOIN && lead <= ControlMsgType.JOIN_RESULT) {
      await this.handleControl(ws, bytes, lead);
      return;
    }
    // leading byte 0x01 (PROTO_VER) or anything else -> data forwarding (Task 12)
  }

  private async handleControl(ws: WebSocket, bytes: Uint8Array, lead: number): Promise<void> {
    const att = this.getAttachment(ws);
    if (lead === ControlMsgType.JOIN) {
      let join: JoinMessage;
      try {
        join = decodeJoin(bytes);
      } catch {
        ws.close(CloseCode.BAD_SIGNAL, 'bad JOIN');
        return;
      }
      if (join.role !== wireRole(att.role)) {
        ws.close(CloseCode.BAD_SIGNAL, 'role mismatch');
        return;
      }
      await this.handleJoin(ws, att, join);
      return;
    }
    // SLOT_AUTH handled in Task 10; CHALLENGE/JOIN_RESULT are DO->client only.
    ws.close(CloseCode.BAD_SIGNAL, 'unexpected control message');
  }

  private async handleJoin(
    ws: WebSocket,
    att: SocketAttachment,
    _join: JoinMessage,
  ): Promise<void> {
    if (att.role === RelayRole.GATEWAY) {
      // Gateway: create on first join; reconnect handling comes in Task 13.
      this.createLink();
      this.issueChallenge(ws, att);
      return;
    }
    // Phone join handled in Task 11.
  }

  // --- test-only RPC surface ---
  async debugCreateLink(): Promise<CreateResult> {
    return this.createLink();
  }
  async debugGetRecord(): Promise<LinkRecord | null> {
    return this.getRecord();
  }
}
```

> This Task-9 block imports and uses only what it needs: `toHex` (for `issueChallenge`'s attachment) and the JOIN/CHALLENGE codec. Task 10 adds the `fromHex` helper and the SLOT_AUTH/JOIN_RESULT imports when they are first used — keeping every intermediate state lint-clean (no unused imports).

- [ ] **Step 4: Run Biome to confirm no unused imports**

Run:
```bash
npx biome check apps/relay/src
```
Expected: no errors.

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- ws-join-gateway
```
Expected: PASS — `4 passed`.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/ws-join-gateway.test.ts
git commit -m "relay: DO WS upgrade + gateway JOIN -> CHALLENGE (frozen control plane)"
```

---

### Task 10: Gateway SLOT_AUTH verification → authed + JOIN_RESULT (commitment-continuity)

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/ws-join-gateway.test.ts` (extend)

After the gateway answers the `CHALLENGE` with a `SLOT_AUTH` (`0x82`) carrying `{ role, slotProof, slotSecretHash }`, the DO:
1. Requires an outstanding single-use challenge (else `4400`).
2. Validates `slotProof` length 32 and `slotSecretHash` length 32 (the codec already enforces this; we re-check defensively and reject otherwise).
3. **Commitment continuity:** on first gateway auth, store `gwSlotSecretHash` = hex of the presented commitment. On any later auth, the presented commitment MUST `bytesEqual` the stored one (a different device cannot take the slot).
4. Consumes the challenge (single-use), marks the socket authed, and replies `JOIN_RESULT{ code: OK, peerPresent: <is the phone slot authed> }`.

> **Why no proof recomputation at the relay:** the relay is zero-knowledge of `slotSecret` (it holds only the SHA-256 commitment), so by construction it cannot recompute `slotAuthProof(slotSecret, challenge)`. The proof's job is to be unforgeable by a network/relay observer and bound to THIS connection's fresh challenge; the relay enforces single-use of the challenge and continuity of the commitment. Peer authorization is the gateway's E2E handshake (Unit C), exactly as the spec scopes slot-auth. See the IMPORTANT cryptographic note in "Prerequisites".

- [ ] **Step 1: Write the failing test.** Append to `apps/relay/test/ws-join-gateway.test.ts`:

```ts
import {
  decodeJoinResult,
  encodeSlotAuth,
  JoinResultCode,
  randomBytes32,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';

it('gateway becomes authed (JOIN_RESULT OK) after a valid SLOT_AUTH', async ({ expect }) => {
  const linkId = `ga${'A'.repeat(30)}`;
  const slotSecret = randomBytes32();
  const res = await connect(linkId, 'gateway');
  const ws = res.webSocket!;
  ws.accept();
  ws.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  const challenge = decodeChallenge(await nextBinary(ws));
  ws.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(slotSecret, challenge),
      slotSecretHash: slotSecretCommitment(slotSecret),
    }),
  );
  const result = await nextBinary(ws);
  expect(peekControlMsgType(result)).toBe(ControlMsgType.JOIN_RESULT);
  const parsed = decodeJoinResult(result);
  expect(parsed.code).toBe(JoinResultCode.OK);
  expect(parsed.peerPresent).toBe(false); // phone not connected yet
  ws.close(1000, 'done');
});

it('a SLOT_AUTH with no outstanding challenge closes 4400', async ({ expect }) => {
  const linkId = `gb${'A'.repeat(30)}`;
  const slotSecret = randomBytes32();
  const res = await connect(linkId, 'gateway');
  const ws = res.webSocket!;
  ws.accept();
  const closed = new Promise<number>((r) =>
    ws.addEventListener('close', (e) => r(e.code), { once: true }),
  );
  // Send SLOT_AUTH before JOIN -> no challenge issued.
  ws.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(slotSecret, new Uint8Array(16)),
      slotSecretHash: slotSecretCommitment(slotSecret),
    }),
  );
  expect(await closed).toBe(4400);
});
```

> `randomBytes32` and `randomBytes16` are frozen exports of `@dash/relay-protocol`. The test imports `randomBytes32` for a fresh slot secret.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- ws-join-gateway
```
Expected: FAIL — the SLOT_AUTH branch does not exist yet; no `JOIN_RESULT` arrives (timeout) and the no-challenge case never closes 4400.

- [ ] **Step 3: Write the implementation.** In `apps/relay/src/relay-link.ts`:

(a) Extend the `@dash/relay-protocol` import block to add the SLOT_AUTH / JOIN_RESULT pieces (replace the Task-9 import block with this exact block). Note the relay stores the presented commitment as-is — it never recomputes it — so `slotSecretCommitment` is NOT imported here:
```ts
import {
  bytesEqual,
  ControlMsgType,
  decodeJoin,
  decodeSlotAuth,
  encodeChallenge,
  encodeJoinResult,
  type JoinMessage,
  JoinResultCode,
  type JoinResultMessage,
  peekControlMsgType,
  randomBytes16,
  Role,
  type SlotAuthMessage,
} from '@dash/relay-protocol';
```
Re-add the `fromHex` helper (it was deferred in Task 9) next to `toHex`:
```ts
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
```

(b) Add a helper to find the authed peer socket (used for `peerPresent` and later notifications). Add it after `issueChallenge`:
```ts
  /** The live, authed socket of the opposite role, if any. */
  private peerSocket(role: RelayRoleT): WebSocket | null {
    const peerRole = role === RelayRole.GATEWAY ? RelayRole.PHONE : RelayRole.GATEWAY;
    for (const sock of this.ctx.getWebSockets(peerRole)) {
      const att = this.getAttachment(sock);
      if (att.authed) return sock;
    }
    return null;
  }
```

(c) Add the SLOT_AUTH branch to `handleControl` (replace the trailing `// SLOT_AUTH handled in Task 10 ...` / `ws.close(... 'unexpected control message')` lines with):
```ts
    if (lead === ControlMsgType.SLOT_AUTH) {
      let slotAuth: SlotAuthMessage;
      try {
        slotAuth = decodeSlotAuth(bytes);
      } catch {
        ws.close(CloseCode.BAD_SIGNAL, 'bad SLOT_AUTH');
        return;
      }
      if (slotAuth.role !== wireRole(att.role)) {
        ws.close(CloseCode.BAD_SIGNAL, 'slot-auth role mismatch');
        return;
      }
      await this.handleSlotAuth(ws, att, slotAuth);
      return;
    }
    // CHALLENGE / JOIN_RESULT are DO->client only; never inbound.
    ws.close(CloseCode.BAD_SIGNAL, 'unexpected control message');
```

(d) Add the `handleSlotAuth` method (after `handleJoin`):
```ts
  private async handleSlotAuth(
    ws: WebSocket,
    att: SocketAttachment,
    slotAuth: SlotAuthMessage,
  ): Promise<void> {
    if (att.challengeHex === null) {
      ws.close(CloseCode.BAD_SIGNAL, 'no outstanding challenge');
      return;
    }
    const record = this.getRecord();
    if (record === null) {
      this.sendResult(ws, JoinResultCode.NO_PENDING_LINK, false);
      ws.close(CloseCode.NO_LINK, 'no link');
      return;
    }
    // Defensive length checks (the codec already guarantees 32/32; re-assert).
    if (slotAuth.slotProof.length !== 32 || slotAuth.slotSecretHash.length !== 32) {
      this.sendResult(ws, JoinResultCode.BAD_PROOF, false);
      ws.close(CloseCode.SLOT_AUTH_FAILED, 'bad slot-auth shape');
      return;
    }
    // Commitment continuity: bind the slot to this device's commitment on first
    // auth; require an exact match on every subsequent (re)connect.
    const presented = slotAuth.slotSecretHash;
    const storedHex =
      att.role === RelayRole.GATEWAY ? record.gwSlotSecretHash : record.phSlotSecretHash;
    if (storedHex !== null && !bytesEqual(fromHex(storedHex), presented)) {
      this.sendResult(ws, JoinResultCode.BAD_PROOF, false);
      ws.close(CloseCode.SLOT_AUTH_FAILED, 'slot commitment changed');
      return;
    }
    // First auth for this role: store the presented commitment verbatim (the relay
    // never recomputes it — it is zero-knowledge of slotSecret). On later auths the
    // bytesEqual check above already enforced continuity.
    if (storedHex === null) {
      const column = att.role === RelayRole.GATEWAY ? 'gwSlotSecretHash' : 'phSlotSecretHash';
      this.ctx.storage.sql.exec(
        `UPDATE link SET ${column} = ? WHERE linkId IS NOT NULL`,
        toHex(presented),
      );
    }
    // Consume the single-use challenge and mark authed.
    this.setAttachment(ws, { ...att, authed: true, challengeHex: null });
    const peerPresent = this.peerSocket(att.role) !== null;
    this.sendResult(ws, JoinResultCode.OK, peerPresent);
  }

  private sendResult(ws: WebSocket, code: number, peerPresent: boolean): void {
    ws.send(encodeJoinResult({ code: code as JoinResultMessage['code'], peerPresent }));
  }
```

> The `column` is chosen from a fixed two-element literal set (never user input), so the template-literal SQL is safe. The `WHERE linkId IS NOT NULL` clause targets the single row (the table holds exactly one link).

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- ws-join-gateway
```
Expected: PASS — `6 passed`.

- [ ] **Step 5: Run Biome**

Run:
```bash
npx biome check apps/relay/src
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/ws-join-gateway.test.ts
git commit -m "relay: gateway SLOT_AUTH verification + JOIN_RESULT (commitment continuity)"
```

---

### Task 11: Phone JOIN/SLOT_AUTH + NO_PENDING_LINK + peer-online nudge

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/ws-join-phone.test.ts`

A phone connecting with `role=phone` sends `JOIN`. The DO requires an existing link (else `JOIN_RESULT{ NO_PENDING_LINK }` + close `4404`). Otherwise it challenges the phone exactly like the gateway. On the phone's first successful `SLOT_AUTH`, its commitment is bound (Task 10's `handleSlotAuth` already stores `phSlotSecretHash`). When the *second* slot authes and a peer is present, the DO nudges BOTH sides with `JOIN_RESULT{ OK, peerPresent: true }` so each learns the other is online.

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/ws-join-phone.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import {
  ControlMsgType,
  decodeChallenge,
  decodeJoinResult,
  encodeJoin,
  encodeSlotAuth,
  JoinResultCode,
  peekControlMsgType,
  randomBytes32,
  Role,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';

function connect(linkId: string, role: 'gateway' | 'phone') {
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  return stub.fetch(`https://relay/connect?linkId=${linkId}&role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}
function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        if (e.data instanceof ArrayBuffer) resolve(new Uint8Array(e.data));
        else reject(new Error('expected binary'));
      },
      { once: true },
    );
  });
}
async function authGateway(linkId: string, secret: Uint8Array) {
  const res = await connect(linkId, 'gateway');
  const ws = res.webSocket!;
  ws.accept();
  ws.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  const ch = decodeChallenge(await nextBinary(ws));
  ws.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(secret, ch),
      slotSecretHash: slotSecretCommitment(secret),
    }),
  );
  await nextBinary(ws); // JOIN_RESULT OK
  return ws;
}

it('phone JOIN on a non-existent link returns NO_PENDING_LINK + closes 4404', async ({
  expect,
}) => {
  const linkId = `p1${'A'.repeat(30)}`;
  const res = await connect(linkId, 'phone');
  const ws = res.webSocket!;
  ws.accept();
  const result = await nextBinary(ws);
  expect(peekControlMsgType(result)).toBe(ControlMsgType.JOIN_RESULT);
  expect(decodeJoinResult(result).code).toBe(JoinResultCode.NO_PENDING_LINK);
});

it('phone joins an existing link, authes, and both sides learn peerPresent', async ({
  expect,
}) => {
  const linkId = `p2${'A'.repeat(30)}`;
  const gwSecret = randomBytes32();
  const phSecret = randomBytes32();
  const gw = await authGateway(linkId, gwSecret);

  const res = await connect(linkId, 'phone');
  const phone = res.webSocket!;
  phone.accept();
  phone.send(encodeJoin({ role: Role.PHONE, linkId }));
  const ch = decodeChallenge(await nextBinary(phone));

  const gwNudge = nextBinary(gw); // gateway should receive a peer-online JOIN_RESULT
  phone.send(
    encodeSlotAuth({
      role: Role.PHONE,
      slotProof: slotAuthProof(phSecret, ch),
      slotSecretHash: slotSecretCommitment(phSecret),
    }),
  );
  const phoneResult = decodeJoinResult(await nextBinary(phone));
  expect(phoneResult.code).toBe(JoinResultCode.OK);
  expect(phoneResult.peerPresent).toBe(true);

  const gwResult = decodeJoinResult(await gwNudge);
  expect(gwResult.code).toBe(JoinResultCode.OK);
  expect(gwResult.peerPresent).toBe(true);

  gw.close(1000, 'done');
  phone.close(1000, 'done');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- ws-join-phone
```
Expected: FAIL — phone JOIN currently falls through (no NO_PENDING_LINK), and no peer-online nudge is sent → both assertions fail/timeout.

- [ ] **Step 3: Write the implementation.** In `apps/relay/src/relay-link.ts`:

(a) Fill in the phone branch of `handleJoin` (replace the `// Phone join handled in Task 11.` comment):
```ts
    // Phone: the link must already exist (gateway created it).
    if (this.getRecord() === null) {
      this.sendResult(ws, JoinResultCode.NO_PENDING_LINK, false);
      ws.close(CloseCode.NO_LINK, 'no pending link');
      return;
    }
    this.issueChallenge(ws, att);
```

(b) In `handleSlotAuth`, after `this.sendResult(ws, JoinResultCode.OK, peerPresent);` and before the method ends, nudge the peer if one is present (this fires when the SECOND slot authes):
```ts
    if (peerPresent) {
      const peer = this.peerSocket(att.role);
      if (peer !== null) this.sendResult(peer, JoinResultCode.OK, true);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- ws-join-phone
```
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/ws-join-phone.test.ts
git commit -m "relay: phone JOIN/SLOT_AUTH + NO_PENDING_LINK + peer-online nudge"
```

---

### Task 12: Verbatim binary forwarding (O(1)) with token-bucket + backpressure

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/ws-forward.test.ts`

Once both slots are authed, a data-plane record (leading byte `0x01` = `PROTO_VER`) from one slot is forwarded byte-for-byte to the other. The relay never decodes/decrypts/chunks it. We gate forwarding by per-socket auth, the per-link token bucket (data frames only — control already bypasses it because it is handled before this path), and a per-peer in-flight ceiling. The token bucket + in-flight counters are ephemeral DO instance fields (authoritative state is the `LinkRecord`; rate counters reset harmlessly on hibernation wake).

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/ws-forward.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import {
  decodeChallenge,
  encodeJoin,
  encodeSlotAuth,
  PROTO_VER,
  randomBytes32,
  Role,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';

function connect(linkId: string, role: 'gateway' | 'phone') {
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  return stub.fetch(`https://relay/connect?linkId=${linkId}&role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}
function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        if (e.data instanceof ArrayBuffer) resolve(new Uint8Array(e.data));
        else reject(new Error('expected binary'));
      },
      { once: true },
    );
  });
}
async function pairUp(linkId: string) {
  const gwSecret = randomBytes32();
  const phSecret = randomBytes32();
  const gwRes = await connect(linkId, 'gateway');
  const gw = gwRes.webSocket!;
  gw.accept();
  gw.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  let ch = decodeChallenge(await nextBinary(gw));
  gw.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(gwSecret, ch),
      slotSecretHash: slotSecretCommitment(gwSecret),
    }),
  );
  await nextBinary(gw); // JOIN_RESULT OK (peerPresent false)
  const phRes = await connect(linkId, 'phone');
  const phone = phRes.webSocket!;
  phone.accept();
  phone.send(encodeJoin({ role: Role.PHONE, linkId }));
  ch = decodeChallenge(await nextBinary(phone));
  const gwNudge = nextBinary(gw);
  phone.send(
    encodeSlotAuth({
      role: Role.PHONE,
      slotProof: slotAuthProof(phSecret, ch),
      slotSecretHash: slotSecretCommitment(phSecret),
    }),
  );
  await nextBinary(phone); // JOIN_RESULT OK (peerPresent true)
  await gwNudge; // gw peer-online nudge
  return { gw, phone };
}

it('forwards a data record phone->gateway verbatim', async ({ expect }) => {
  const { gw, phone } = await pairUp(`f1${'A'.repeat(30)}`);
  // A data-plane record begins with PROTO_VER (0x01). Contents are opaque to the relay.
  const payload = new Uint8Array([PROTO_VER, 2, 3, 4, 250, 255, 0]);
  const got = nextBinary(gw);
  phone.send(payload);
  expect(Array.from(await got)).toEqual(Array.from(payload));
  gw.close(1000, 'done');
  phone.close(1000, 'done');
});

it('forwards a data record gateway->phone verbatim', async ({ expect }) => {
  const { gw, phone } = await pairUp(`f2${'A'.repeat(30)}`);
  const payload = new Uint8Array(1000);
  payload[0] = PROTO_VER;
  for (let i = 1; i < payload.length; i++) payload[i] = i % 256;
  const got = nextBinary(phone);
  gw.send(payload);
  expect(Array.from(await got)).toEqual(Array.from(payload));
  gw.close(1000, 'done');
  phone.close(1000, 'done');
});

it('drops a data record from an unauthed socket (closes 4401)', async ({ expect }) => {
  const linkId = `f3${'A'.repeat(30)}`;
  const res = await connect(linkId, 'gateway');
  const ws = res.webSocket!;
  ws.accept();
  const closed = new Promise<number>((r) =>
    ws.addEventListener('close', (e) => r(e.code), { once: true }),
  );
  ws.send(new Uint8Array([PROTO_VER, 9, 9, 9])); // data before auth
  expect(await closed).toBe(4401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- ws-forward
```
Expected: FAIL — the data branch of `webSocketMessage` is a no-op; `nextBinary(gw)` times out and the unauthed-data case never closes 4401.

- [ ] **Step 3: Write the implementation.** In `apps/relay/src/relay-link.ts`:

(a) Extend the protocol import to bring in the limits + add the token bucket import. Replace the `import { CloseCode, RelayRole, type RelayRole as RelayRoleT } from './protocol.js';` line with:
```ts
import {
  CEILING_BYTES,
  CloseCode,
  RelayRole,
  type RelayRole as RelayRoleT,
  TOKEN_BUCKET_CAPACITY,
  TOKEN_BUCKET_REFILL_PER_SEC,
} from './protocol.js';
import { TokenBucket } from './token-bucket.js';
```

(b) Add instance fields to the class (just inside the class body, before the constructor):
```ts
  private bucket: TokenBucket | null = null;
  /** In-flight bytes accounted toward each role's socket (backpressure ceiling). */
  private inflight: Record<RelayRoleT, number> = { gateway: 0, phone: 0 };
```

(c) Route data records in `webSocketMessage`. Replace the trailing comment line `// leading byte 0x01 (PROTO_VER) or anything else -> data forwarding (Task 12)` with:
```ts
    this.forwardData(ws, bytes);
```

(d) Add the `forwardData` method (after `handleSlotAuth`):
```ts
  /** Verbatim, O(1) forward of one data-plane record to the peer slot, gated by
   *  per-socket auth, the per-link token bucket, and the per-peer in-flight ceiling.
   *  The relay never inspects the record beyond its already-checked leading byte. */
  private forwardData(ws: WebSocket, bytes: Uint8Array): void {
    const att = this.getAttachment(ws);
    if (!att.authed) {
      ws.close(CloseCode.SLOT_AUTH_FAILED, 'unauthed data');
      return;
    }
    if (this.bucket === null) {
      this.bucket = new TokenBucket({
        capacity: TOKEN_BUCKET_CAPACITY,
        refillPerSec: TOKEN_BUCKET_REFILL_PER_SEC,
      });
    }
    if (!this.bucket.tryRemove()) {
      ws.close(CloseCode.POLICY_VIOLATION, 'frame rate exceeded');
      return;
    }
    const peer = this.peerSocket(att.role);
    if (peer === null) return; // peer offline: drop (the phone resumes via seq replay in Unit C/D)
    const peerRole = att.role === RelayRole.GATEWAY ? RelayRole.PHONE : RelayRole.GATEWAY;
    const size = bytes.byteLength;
    if (this.inflight[peerRole] + size > CEILING_BYTES) {
      peer.close(CloseCode.TRY_AGAIN_LATER, 'backpressure ceiling');
      this.inflight[peerRole] = 0;
      return;
    }
    this.inflight[peerRole] += size;
    peer.send(bytes);
    // workerd's send() enqueues synchronously to the peer's outbound buffer, so we
    // decrement immediately. The ceiling still bounds a single synchronous burst,
    // and HIGH_WATER_BYTES is reserved for a future read-pause (workerd does not
    // expose per-socket read-pause on hibernatable sockets today).
    this.inflight[peerRole] = Math.max(0, this.inflight[peerRole] - size);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- ws-forward
```
Expected: PASS — `3 passed`.

- [ ] **Step 5: Run Biome**

Run:
```bash
npx biome check apps/relay/src
```
Expected: no errors. (`HIGH_WATER_BYTES` is intentionally NOT imported here — it is referenced only in prose. If a previous task left it imported and unused, remove it.)

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/ws-forward.test.ts
git commit -m "relay: verbatim O(1) data forwarding with token bucket + ceiling"
```

---

### Task 13: PENDING_TTL alarm — unpaired links self-destruct after 75 s

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/ttl.test.ts`

When a link is created, the DO arms an alarm at `PENDING_TTL_MS`. If the link is still `pending` (not yet `paired`) when the alarm fires, the DO tears down: close any live sockets with `UNLINKED` and `deleteAll()`. Pairing (Task 14) clears the alarm. We fire the alarm immediately in tests via `runDurableObjectAlarm(stub)`.

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/ttl.test.ts`:

```ts
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import type { RelayLink } from '../src/relay-link.js';

it('arms an alarm on create', async ({ expect }) => {
  const stub = env.LINK.get(env.LINK.idFromName(`t1${'A'.repeat(30)}`));
  await stub.debugCreateLink();
  await runInDurableObject(stub, async (_i: RelayLink, state) => {
    expect(await state.storage.getAlarm()).not.toBe(null);
  });
});

it('a still-pending link is deleted when the PENDING_TTL alarm fires', async ({ expect }) => {
  const stub = env.LINK.get(env.LINK.idFromName(`t2${'A'.repeat(30)}`));
  await stub.debugCreateLink();
  const ran = await runDurableObjectAlarm(stub);
  expect(ran).toBe(true);
  expect(await stub.debugGetRecord()).toBe(null); // record wiped by deleteAll
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- ttl
```
Expected: FAIL — `createLink` arms no alarm (`getAlarm()` is null) and there is no `alarm()` handler (`runDurableObjectAlarm` returns false; the record persists).

- [ ] **Step 3: Write the implementation.** In `apps/relay/src/relay-link.ts`:

(a) Add `PENDING_TTL_MS` to the protocol import block:
```ts
import {
  CEILING_BYTES,
  CloseCode,
  PENDING_TTL_MS,
  RelayRole,
  type RelayRole as RelayRoleT,
  TOKEN_BUCKET_CAPACITY,
  TOKEN_BUCKET_REFILL_PER_SEC,
} from './protocol.js';
```

(b) Arm the alarm at the end of `createLink`, just before `return { ok: true };`:
```ts
    this.ctx.storage.setAlarm(Date.now() + PENDING_TTL_MS);
```

(c) Add the `alarm()` handler and a shared `teardown` helper to the class (after `forwardData`):
```ts
  /** Fires at PENDING_TTL after create. If still unpaired, tear the link down. */
  async alarm(): Promise<void> {
    const record = this.getRecord();
    if (record !== null && record.state === 'paired') return; // paired links don't expire here
    this.teardown(CloseCode.UNLINKED, 'pairing window expired');
  }

  /** Close every live socket with `code`/`reason` and wipe all durable state. */
  private teardown(code: number, reason: string): void {
    for (const sock of this.ctx.getWebSockets()) {
      try {
        sock.close(code, reason);
      } catch {
        // socket already closing/closed — ignore
      }
    }
    this.ctx.storage.deleteAll();
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- ttl
```
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/ttl.test.ts
git commit -m "relay: PENDING_TTL alarm tears down still-pending links"
```

---

### Task 14: Pairing → `paired` (clears TTL) + UNLINK teardown via CLOSE control

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/lifecycle.test.ts`

Two lifecycle transitions:
1. When the phone authes and the gateway peer is present, the link becomes `paired` and the PENDING_TTL alarm is cleared.
2. Teardown: an authed socket can request a hard unlink. The frozen control plane has no dedicated "unlink" message, so we reuse the data-plane `CLOSE` opcode semantics at the relay level via a tiny relay convention: an authed socket that sends a 1-byte data record `[0x02]` (`Opcode.CLOSE` from the frozen contract, sent as a bare control intent) triggers `teardown`. To keep this unambiguous and avoid colliding with real CLOSE frames inside the encrypted channel, the relay treats a single-byte binary message equal to `[CloseCode.UNLINK_INTENT]` — a relay-local sentinel `0xFE` — as the unlink request. This sentinel is NOT a frozen-contract byte (it is `>0x83` and `!=0x01`, so it cannot be confused with a data record or a control message), and Unit C/D send it deliberately on desktop unpair.

> Define the sentinel in `protocol.ts` so all units agree. We add `UNLINK_INTENT = 0xfe` to the relay protocol constants. The desktop/cli send `new Uint8Array([0xfe])` over an authed socket to revoke. This is a RELAY-LOCAL teardown channel, never E2E content; the relay forwarding path already rejects it from unauthed sockets (Task 12 closes 4401 before reaching here, because an unauthed socket cannot forward data — but the sentinel is intercepted in `webSocketMessage` BEFORE the data path, and only honored when authed).

- [ ] **Step 1: Add the sentinel constant.** In `apps/relay/src/protocol.ts`, add after `LINK_ID_LEN`:
```ts
/**
 * Relay-local teardown sentinel: an authed socket sends a single byte 0xFE to
 * request a hard unlink (closes both peers + deletes durable state). 0xFE is
 * neither a data-plane record (leading byte 0x01) nor a control message
 * (0x80-0x83), so it can never be confused with real traffic. Never E2E content.
 */
export const UNLINK_INTENT = 0xfe;
```

- [ ] **Step 2: Write the failing test.** Create `apps/relay/test/lifecycle.test.ts`:

```ts
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import {
  decodeChallenge,
  encodeJoin,
  encodeSlotAuth,
  randomBytes32,
  Role,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';
import type { RelayLink } from '../src/relay-link.js';

function connect(linkId: string, role: 'gateway' | 'phone') {
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  return stub.fetch(`https://relay/connect?linkId=${linkId}&role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}
function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        if (e.data instanceof ArrayBuffer) resolve(new Uint8Array(e.data));
        else reject(new Error('expected binary'));
      },
      { once: true },
    );
  });
}
async function pairUp(linkId: string) {
  const gwSecret = randomBytes32();
  const phSecret = randomBytes32();
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  const gw = (await connect(linkId, 'gateway')).webSocket!;
  gw.accept();
  gw.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  let ch = decodeChallenge(await nextBinary(gw));
  gw.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(gwSecret, ch),
      slotSecretHash: slotSecretCommitment(gwSecret),
    }),
  );
  await nextBinary(gw);
  const phone = (await connect(linkId, 'phone')).webSocket!;
  phone.accept();
  phone.send(encodeJoin({ role: Role.PHONE, linkId }));
  ch = decodeChallenge(await nextBinary(phone));
  const gwNudge = nextBinary(gw);
  phone.send(
    encodeSlotAuth({
      role: Role.PHONE,
      slotProof: slotAuthProof(phSecret, ch),
      slotSecretHash: slotSecretCommitment(phSecret),
    }),
  );
  await nextBinary(phone);
  await gwNudge;
  return { gw, phone, stub };
}

it('phone auth marks the link paired and clears the pending alarm', async ({ expect }) => {
  const { gw, phone, stub } = await pairUp(`l1${'A'.repeat(30)}`);
  expect((await stub.debugGetRecord())?.state).toBe('paired');
  await runInDurableObject(stub, async (_i: RelayLink, state) => {
    expect(await state.storage.getAlarm()).toBe(null);
  });
  gw.close(1000, 'done');
  phone.close(1000, 'done');
});

it('an UNLINK_INTENT from the gateway tears the link down and closes the phone with 4410', async ({
  expect,
}) => {
  const { gw, phone, stub } = await pairUp(`l2${'A'.repeat(30)}`);
  const phoneClosed = new Promise<number>((r) =>
    phone.addEventListener('close', (e) => r(e.code), { once: true }),
  );
  gw.send(new Uint8Array([0xfe]));
  expect(await phoneClosed).toBe(4410);
  expect(await stub.debugGetRecord()).toBe(null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- lifecycle
```
Expected: FAIL — state never becomes `paired`, the alarm is not cleared, and the `0xFE` sentinel is treated as a data record (forwarded, not a teardown).

- [ ] **Step 4: Write the implementation.** In `apps/relay/src/relay-link.ts`:

(a) Add `UNLINK_INTENT` to the protocol import block:
```ts
import {
  CEILING_BYTES,
  CloseCode,
  PENDING_TTL_MS,
  RelayRole,
  type RelayRole as RelayRoleT,
  TOKEN_BUCKET_CAPACITY,
  TOKEN_BUCKET_REFILL_PER_SEC,
  UNLINK_INTENT,
} from './protocol.js';
```

(b) Intercept the unlink sentinel in `webSocketMessage` BEFORE the control/data routing. Immediately after computing `bytes` and before the `peekControlMsgType` block, add:
```ts
    if (bytes.byteLength === 1 && bytes[0] === UNLINK_INTENT) {
      const att = this.getAttachment(ws);
      if (att.authed) {
        this.teardown(CloseCode.UNLINKED, 'unlinked');
      } else {
        ws.close(CloseCode.SLOT_AUTH_FAILED, 'unauthed unlink');
      }
      return;
    }
```

(c) In `handleSlotAuth`, promote to `paired` when the phone authes with the gateway present. After the `if (peerPresent) { ... }` nudge block and before the method ends, add:
```ts
    if (att.role === RelayRole.PHONE && peerPresent) {
      this.ctx.storage.sql.exec(
        "UPDATE link SET state = 'paired', pairedAt = ? WHERE linkId IS NOT NULL",
        Date.now(),
      );
      this.ctx.storage.deleteAlarm();
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- lifecycle
```
Expected: PASS — `2 passed`.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/src/protocol.ts apps/relay/test/lifecycle.test.ts
git commit -m "relay: pairing -> paired (clears TTL); UNLINK_INTENT teardown closes both"
```

---

### Task 15: Reconnect eviction on re-auth (no peer-kick by an unauthed attacker)

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/reconnect.test.ts`

On reconnect, a gateway re-joins an existing link: the JOIN finds a record, so instead of erroring it re-issues a `CHALLENGE` (re-auth). When the newcomer passes `SLOT_AUTH`, the DO evicts any OTHER authed socket of the same role (the stale one) and closes it `SLOT_TAKEN`. Eviction-on-successful-auth (not on connect) means an unauthenticated attacker cannot kick the legitimate socket: it must clear commitment-continuity + the fresh challenge first. (A wrong commitment closes `4401` before any eviction.)

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/reconnect.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import {
  ControlMsgType,
  decodeChallenge,
  decodeJoinResult,
  encodeJoin,
  encodeSlotAuth,
  JoinResultCode,
  peekControlMsgType,
  Role,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';

function connect(linkId: string, role: 'gateway' | 'phone') {
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  return stub.fetch(`https://relay/connect?linkId=${linkId}&role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}
function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        if (e.data instanceof ArrayBuffer) resolve(new Uint8Array(e.data));
        else reject(new Error('expected binary'));
      },
      { once: true },
    );
  });
}
async function authGateway(linkId: string, secret: Uint8Array) {
  const gw = (await connect(linkId, 'gateway')).webSocket!;
  gw.accept();
  gw.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  const ch = decodeChallenge(await nextBinary(gw));
  gw.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(secret, ch),
      slotSecretHash: slotSecretCommitment(secret),
    }),
  );
  await nextBinary(gw); // JOIN_RESULT OK
  return gw;
}

it('a reconnecting gateway that re-authes evicts the stale socket (closed 4409)', async ({
  expect,
}) => {
  const linkId = `rc1${'A'.repeat(29)}`;
  const secret = new Uint8Array(32).fill(1);
  const gw1 = await authGateway(linkId, secret);
  const gw1Closed = new Promise<number>((r) =>
    gw1.addEventListener('close', (e) => r(e.code), { once: true }),
  );

  const gw2 = (await connect(linkId, 'gateway')).webSocket!;
  gw2.accept();
  gw2.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  const msg = await nextBinary(gw2);
  expect(peekControlMsgType(msg)).toBe(ControlMsgType.CHALLENGE); // reconnect re-challenges
  const ch = decodeChallenge(msg);
  gw2.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(secret, ch),
      slotSecretHash: slotSecretCommitment(secret),
    }),
  );
  expect(decodeJoinResult(await nextBinary(gw2)).code).toBe(JoinResultCode.OK);
  expect(await gw1Closed).toBe(4409);
  gw2.close(1000, 'done');
});

it('a reconnecting gateway with a DIFFERENT slot secret is rejected (4401, no eviction)', async ({
  expect,
}) => {
  const linkId = `rc2${'A'.repeat(29)}`;
  const gw1 = await authGateway(linkId, new Uint8Array(32).fill(1));
  let gw1Closed = false;
  gw1.addEventListener('close', () => {
    gw1Closed = true;
  });

  const gw2 = (await connect(linkId, 'gateway')).webSocket!;
  gw2.accept();
  const gw2Closed = new Promise<number>((r) =>
    gw2.addEventListener('close', (e) => r(e.code), { once: true }),
  );
  gw2.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  const ch = decodeChallenge(await nextBinary(gw2));
  const attacker = new Uint8Array(32).fill(2); // wrong commitment
  gw2.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(attacker, ch),
      slotSecretHash: slotSecretCommitment(attacker),
    }),
  );
  expect(await gw2Closed).toBe(4401);
  expect(gw1Closed).toBe(false); // legitimate socket NOT evicted
  gw1.close(1000, 'done');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- reconnect
```
Expected: FAIL — a gateway JOIN on an existing link currently just calls `createLink()` (no-op) and re-challenges (that part may pass), but no eviction happens, so `gw1Closed` never resolves to 4409.

- [ ] **Step 3: Write the implementation.** In `apps/relay/src/relay-link.ts`, in `handleSlotAuth`, immediately after `this.setAttachment(ws, { ...att, authed: true, challengeHex: null });` and before computing `peerPresent`, evict any OTHER authed socket of the same role:
```ts
    for (const other of this.ctx.getWebSockets(att.role)) {
      if (other !== ws) {
        const otherAtt = this.getAttachment(other);
        if (otherAtt.authed) other.close(CloseCode.SLOT_TAKEN, 'evicted by reconnect');
      }
    }
```

> The gateway JOIN path already re-challenges on an existing link: `handleJoin`'s gateway branch calls `createLink()` (which no-ops when the record exists) then `issueChallenge`. No change needed there — the re-challenge already works; this task only adds eviction on the subsequent successful auth.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- reconnect
```
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/reconnect.test.ts
git commit -m "relay: reconnect re-challenge + stale-socket eviction on successful re-auth"
```

---

### Task 16: peer-offline on socket close/error

**Files:** Modify `apps/relay/src/relay-link.ts`, Create `apps/relay/test/peer-offline.test.ts`

When an authed socket closes or errors, notify the surviving authed peer with `JOIN_RESULT{ code: OK, peerPresent: false }` so its UI reflects the disconnect promptly. (Edge auto-pong is NOT peer liveness; the E2E PING/PONG inside the encrypted channel is the real liveness signal — but this gives a fast hint.)

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/peer-offline.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import {
  decodeChallenge,
  decodeJoinResult,
  encodeJoin,
  encodeSlotAuth,
  randomBytes32,
  Role,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';

function connect(linkId: string, role: 'gateway' | 'phone') {
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  return stub.fetch(`https://relay/connect?linkId=${linkId}&role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}
function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        if (e.data instanceof ArrayBuffer) resolve(new Uint8Array(e.data));
        else reject(new Error('expected binary'));
      },
      { once: true },
    );
  });
}
async function pairUp(linkId: string) {
  const gwSecret = randomBytes32();
  const phSecret = randomBytes32();
  const gw = (await connect(linkId, 'gateway')).webSocket!;
  gw.accept();
  gw.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  let ch = decodeChallenge(await nextBinary(gw));
  gw.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(gwSecret, ch),
      slotSecretHash: slotSecretCommitment(gwSecret),
    }),
  );
  await nextBinary(gw);
  const phone = (await connect(linkId, 'phone')).webSocket!;
  phone.accept();
  phone.send(encodeJoin({ role: Role.PHONE, linkId }));
  ch = decodeChallenge(await nextBinary(phone));
  const gwNudge = nextBinary(gw);
  phone.send(
    encodeSlotAuth({
      role: Role.PHONE,
      slotProof: slotAuthProof(phSecret, ch),
      slotSecretHash: slotSecretCommitment(phSecret),
    }),
  );
  await nextBinary(phone);
  await gwNudge;
  return { gw, phone };
}

it('closing the phone notifies the gateway peerPresent=false', async ({ expect }) => {
  const { gw, phone } = await pairUp(`po${'A'.repeat(30)}`);
  const offline = nextBinary(gw);
  phone.close(1000, 'bye');
  expect(decodeJoinResult(await offline).peerPresent).toBe(false);
  gw.close(1000, 'done');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- peer-offline
```
Expected: FAIL — there is no `webSocketClose` handler, so the gateway never receives the offline nudge → timeout.

- [ ] **Step 3: Write the implementation.** Add the close/error handlers + helper to the class in `apps/relay/src/relay-link.ts` (after `teardown`):

```ts
  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.notifyPeerOffline(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.notifyPeerOffline(ws);
  }

  private notifyPeerOffline(ws: WebSocket): void {
    let att: SocketAttachment;
    try {
      att = this.getAttachment(ws);
    } catch {
      return; // never attached
    }
    if (!att.authed) return;
    const peer = this.peerSocket(att.role);
    if (peer !== null) this.sendResult(peer, JoinResultCode.OK, false);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- peer-offline
```
Expected: PASS — `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/relay-link.ts apps/relay/test/peer-offline.test.ts
git commit -m "relay: notify surviving peer peerPresent=false on socket close/error"
```

---

### Task 17: Worker shim — Upgrade gate, linkId shape gate, per-IP rate limit, route to DO

**Files:** Modify `apps/relay/src/index.ts`, Create `apps/relay/test/worker.test.ts`

The stateless Worker is the front door: only it does the cheap rejects before spawning a DO. Tests hit `exports.default.fetch(request, env)` (the `exports` binding from `cloudflare:workers`).

- [ ] **Step 1: Write the failing test.** Create `apps/relay/test/worker.test.ts`:

```ts
import { env, exports } from 'cloudflare:workers';
import { it } from 'vitest';

const validLinkId = 'A'.repeat(32);

it('returns 426 without an Upgrade header on /connect', async ({ expect }) => {
  const res = await exports.default.fetch(
    new Request(`https://relay/connect?linkId=${validLinkId}&role=gateway`),
    env,
  );
  expect(res.status).toBe(426);
});

it('returns 400 for a malformed linkId', async ({ expect }) => {
  const res = await exports.default.fetch(
    new Request('https://relay/connect?linkId=short&role=gateway', {
      headers: { Upgrade: 'websocket' },
    }),
    env,
  );
  expect(res.status).toBe(400);
});

it('returns 400 when linkId is missing', async ({ expect }) => {
  const res = await exports.default.fetch(
    new Request('https://relay/connect?role=gateway', {
      headers: { Upgrade: 'websocket' },
    }),
    env,
  );
  expect(res.status).toBe(400);
});

it('routes a well-formed upgrade to the DO (101)', async ({ expect }) => {
  const res = await exports.default.fetch(
    new Request(`https://relay/connect?linkId=${'B'.repeat(32)}&role=gateway`, {
      headers: { Upgrade: 'websocket' },
    }),
    env,
  );
  expect(res.status).toBe(101);
  res.webSocket?.close?.(1000, 'done');
});

it('returns 200 on the health root', async ({ expect }) => {
  const res = await exports.default.fetch(new Request('https://relay/'), env);
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm test --workspace=apps/relay -- worker
```
Expected: FAIL — the current default fetch returns 200 for everything; the 426/400/101 cases do not hold.

- [ ] **Step 3: Write the implementation.** Replace `apps/relay/src/index.ts` with:

```ts
import { IpRateLimiter } from './ip-rate-limit.js';
import { extractLinkId, isValidLinkId } from './link-id.js';
import { RelayLink } from './relay-link.js';

export { RelayLink };

// Per-IP connect limiter: ~30 connects / 60 s. Module-scope so it persists across
// requests within a single Worker isolate (per-CF-location, approximate; backstopped
// by the WAF and per-DO caps — documented residual risk).
const connectLimiter = new IpRateLimiter({ limit: 30, windowMs: 60_000 });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/connect') {
      return new Response('dash-relay', { status: 200 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    const linkId = extractLinkId(request);
    if (linkId === null || !isValidLinkId(linkId)) {
      return new Response('invalid linkId', { status: 400 });
    }
    const ip = request.headers.get('cf-connecting-ip');
    if (!connectLimiter.allow(ip)) {
      return new Response('rate limited', { status: 429 });
    }
    const stub = env.LINK.getByName(linkId);
    return stub.fetch(request);
  },
};
```

> `env.LINK.getByName(linkId)` is sugar for `env.LINK.get(env.LINK.idFromName(linkId))` (current `workerd`): the `linkId` IS the DO name — race-free, enumeration-free, no registry, exactly as the spec requires.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm test --workspace=apps/relay -- worker
```
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/index.ts apps/relay/test/worker.test.ts
git commit -m "relay: stateless Worker shim — Upgrade/linkId gates, IP rate limit, DO routing"
```

---

### Task 18: Hibernation-state survival test (tags + storage + attachment round-trip)

**Files:** Create `apps/relay/test/hibernation.test.ts`

Prove the authoritative state survives a hibernation cycle: (a) `getTags` recovers the role tag, (b) the `LinkRecord` is in SQLite storage (not a JS field), and (c) the per-socket attachment (`role`/`authed`/`challengeHex`) is readable via `deserializeAttachment`. The implementation already satisfies these; this is a verification test.

- [ ] **Step 1: Write the test.** Create `apps/relay/test/hibernation.test.ts`:

```ts
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import {
  decodeChallenge,
  encodeJoin,
  encodeSlotAuth,
  Role,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';
import type { RelayLink } from '../src/relay-link.js';

function connect(linkId: string, role: 'gateway' | 'phone') {
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  return stub.fetch(`https://relay/connect?linkId=${linkId}&role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}
function nextBinary(ws: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 5000);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        if (e.data instanceof ArrayBuffer) resolve(new Uint8Array(e.data));
        else reject(new Error('expected binary'));
      },
      { once: true },
    );
  });
}

it('role tag + storage + attachment survive (hibernation-safe identity)', async ({ expect }) => {
  const linkId = `hb${'A'.repeat(30)}`;
  const secret = new Uint8Array(32).fill(5);
  const commitmentHex = Array.from(slotSecretCommitment(secret))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const stub = env.LINK.get(env.LINK.idFromName(linkId));
  const gw = (await connect(linkId, 'gateway')).webSocket!;
  gw.accept();
  gw.send(encodeJoin({ role: Role.GATEWAY, linkId }));
  const ch = decodeChallenge(await nextBinary(gw));
  gw.send(
    encodeSlotAuth({
      role: Role.GATEWAY,
      slotProof: slotAuthProof(secret, ch),
      slotSecretHash: slotSecretCommitment(secret),
    }),
  );
  await nextBinary(gw); // JOIN_RESULT OK

  await runInDurableObject(stub, async (_i: RelayLink, state) => {
    const sockets = state.getWebSockets('gateway');
    expect(sockets.length).toBe(1);
    expect(state.getTags(sockets[0])).toContain('gateway');
    const row = state.storage.sql
      .exec<{ gwSlotSecretHash: string }>('SELECT gwSlotSecretHash FROM link LIMIT 1')
      .one();
    expect(row.gwSlotSecretHash).toBe(commitmentHex);
    const att = sockets[0].deserializeAttachment() as { role: string; authed: boolean };
    expect(att.role).toBe('gateway');
    expect(att.authed).toBe(true);
  });

  gw.close(1000, 'done');
});
```

- [ ] **Step 2: Run the test (it should PASS immediately — invariants already hold)**

Run:
```bash
npm test --workspace=apps/relay -- hibernation
```
Expected: PASS — `1 passed`. (If `getTags` throws "WebSocket not associated", the socket was not accepted with the tag — revisit Task 9 Step 3.)

- [ ] **Step 3: Commit**

```bash
git add apps/relay/test/hibernation.test.ts
git commit -m "relay: hibernation-state survival test (tags + storage + attachment)"
```

---

### Task 19: Full-suite green, lint, type-check, dry-run deploy + deployer README

**Files:** Create `apps/relay/README.md` — plus verification only

- [ ] **Step 1: Run the entire relay suite**

Run:
```bash
npm test --workspace=apps/relay
```
Expected: PASS — all suites green (smoke, protocol, link-id, ip-rate-limit, token-bucket, link-record, ws-join-gateway, ws-join-phone, ws-forward, ttl, lifecycle, reconnect, peer-offline, worker, hibernation).

- [ ] **Step 2: Confirm the root suite still passes and excludes the relay**

Run:
```bash
npm test 2>&1 | tail -8
```
Expected: PASS — no `apps/relay` test files are collected by the root config.

- [ ] **Step 3: Lint the whole relay package with Biome**

Run:
```bash
npx biome check apps/relay/src apps/relay/test
```
Expected: no errors. If formatting differs, run `npx biome check --write apps/relay/src apps/relay/test` and re-run.

- [ ] **Step 4: Regenerate binding types and type-check the worker**

Run:
```bash
npm run cf-types --workspace=apps/relay && npx tsc --noEmit -p apps/relay/tsconfig.json
```
Expected: no type errors. (Validates `Env`, the `RelayLink` DO class, and the `cloudflare:*` ambient types.)

- [ ] **Step 5: Dry-run the deploy config (no actual deploy, no credentials)**

Run:
```bash
npx --workspace=apps/relay wrangler deploy --dry-run --outdir apps/relay/dist 2>&1 | tail -15
```
Expected: wrangler bundles `src/index.ts`, reports the `RelayLink` DO binding + the `new_sqlite_classes` migration, and prints a dry-run completion line with no errors.

- [ ] **Step 6: Create `apps/relay/README.md`** for the deployer

```md
# @dash/relay — Dash zero-knowledge transport relay

A Cloudflare Worker plus one `RelayLink` Durable Object per `linkId`. It pipes
opaque end-to-end-encrypted WebSocket binary records between a Dash gateway
(dialing out) and a paired phone. The relay never decrypts payloads, never sees
the pairing secret or the management token, and stores only the SHA-256
commitments of each side's `slotSecret`.

## Develop

```bash
npm run dev --workspace=apps/relay     # wrangler dev (local workerd)
npm test --workspace=apps/relay        # vitest (workers pool)
```

## Deploy

1. Edit `wrangler.jsonc` -> `env.production.routes[0].pattern` to your custom
   domain (e.g. `relay.dash.yourdomain.com`). The domain must be a zone on the
   deploying Cloudflare account; a `workers.dev` host is intentionally NOT used.
2. Authenticate: `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
3. Deploy dev:  `npm run deploy --workspace=apps/relay`
   Deploy prod: `npm run deploy:prod --workspace=apps/relay`

## Protocol (frozen — @dash/relay-protocol control plane)

- Clients connect to `wss://<host>/connect?linkId=<32 base64url chars>&role=gateway|phone`.
- Control plane = binary messages with leading byte `0x80`–`0x83`
  (`JOIN`, `CHALLENGE`, `SLOT_AUTH`, `JOIN_RESULT`). One construction, used
  identically by gateway and phone. Slot-auth = a single-use server `CHALLENGE`
  answered by `slotProof = HMAC(slotSecret, "dash-slot-v1" ‖ challenge)` with the
  commitment `slotSecretHash = SHA-256(slotSecret)`. It is anti-DoS only — it
  never authorizes the E2E peer; the gateway's E2E handshake does.
- Data plane = binary records with leading byte `0x01` (`PROTO_VER`), forwarded
  verbatim to the opposite slot. The relay never decodes them.
- Teardown: an authed socket sends a single byte `0xFE` (relay-local
  `UNLINK_INTENT`) to revoke; the relay closes both peers + deletes all state.
- Close codes: 1008 rate-limit, 1013 backpressure, 4400 bad-signal,
  4401 slot-auth-failed, 4404 no-link, 4409 slot-taken, 4410 unlinked.

## Limits

- Max WS message: 32 MiB (forwarded verbatim; no chunking/reassembly at the relay).
- Per-link frame rate: ~200 data frames/s (token bucket -> close 1008).
- Per-peer in-flight ceiling: 24 MiB -> close 1013.
- `PENDING_TTL`: 75 s for an unpaired link; optional 7-day idle GC for paired links.
```

- [ ] **Step 7: Commit**

```bash
git add apps/relay/README.md
git commit -m "relay: deployer README; full suite + lint + type-check + dry-run green"
```

---

## Done criteria for Unit B

- `npm test --workspace=apps/relay` is fully green across all 15 test files.
- `npm test` (root) is green and collects ZERO relay tests.
- `npx biome check apps/relay/src apps/relay/test` is clean (no `any`, no unused imports).
- `npx tsc --noEmit -p apps/relay/tsconfig.json` is clean.
- `wrangler deploy --dry-run` bundles cleanly with the DO binding + SQLite migration.
- The relay imports the control plane EXCLUSIVELY from `@dash/relay-protocol` (verify: `grep -rn "@dash/relay-protocol" apps/relay/src` shows the imports; `grep -rn "@relay-protocol" apps/relay` returns nothing).

---

## Frozen interfaces this unit exposes to later units (C: gateway tunnel-client, D: CLI harness)

These are the relay's OBSERVABLE wire behaviors that Units C and D build against. They reference `@dash/relay-protocol` exports by exact name; no variants.

**Connect endpoint:** `wss://<relayUrl>/connect?linkId=<32 base64url chars>&role=gateway|phone`. The Worker enforces: `Upgrade: websocket` (else HTTP 426), `linkId` shape (32 base64url, else 400), per-IP ~30/60 s connect limit (else 429). The DO tags the socket with the connect-time role; the JOIN's numeric `Role` MUST match it (else close 4400).

**Join handshake (every connection, gateway and phone identical sequence):**
1. Client → DO: `encodeJoin({ role, linkId })` (`Role.GATEWAY` or `Role.PHONE`).
2. DO → client: `encodeChallenge(challenge16)` — a fresh single-use 16-byte CSPRNG challenge per (re)connect.
3. Client → DO: `encodeSlotAuth({ role, slotProof: slotAuthProof(slotSecret, challenge), slotSecretHash: slotSecretCommitment(slotSecret) })`.
4. DO → client: `encodeJoinResult({ code, peerPresent })`.
   - First gateway JOIN with no record ⇒ link created (`pending`), PENDING_TTL=75 s armed.
   - Phone JOIN with no record ⇒ `JoinResultCode.NO_PENDING_LINK` then close 4404.
   - Gateway JOIN with existing record ⇒ reconnect: re-`CHALLENGE`, then on successful `SLOT_AUTH` evict the stale same-role socket (closes it 4409).
   - Successful auth ⇒ `JoinResultCode.OK`, `peerPresent` = is the opposite slot authed now.
   - Commitment continuity: the first `slotSecretHash` per role is bound; a later DIFFERENT `slotSecretHash` ⇒ `JoinResultCode.BAD_PROOF` + close 4401.

**Peer-online / peer-offline nudges:** when the SECOND slot authes, BOTH sockets receive `encodeJoinResult({ code: OK, peerPresent: true })`. When an authed socket closes/errors, the survivor receives `encodeJoinResult({ code: OK, peerPresent: false })`. Units C/D distinguish their own auth result from a nudge by sequencing (the auth result is the immediate reply to their `SLOT_AUTH`; subsequent `JOIN_RESULT`s are peer-presence nudges).

**Pairing transition:** when the phone authes with the gateway present, the link becomes `paired` and the PENDING_TTL alarm is cleared.

**Data plane:** after `JoinResultCode.OK`, either side sends binary data-plane records (leading byte `0x01` = `PROTO_VER`, i.e. `sealRecord(...).bytes`). The relay forwards them byte-for-byte to the opposite slot — no decode, decrypt, chunk, or reassembly. If the peer is offline the record is dropped (Unit C/D recover via `seq`/replay). Limits: per-link ~200 data frames/s (`TOKEN_BUCKET_CAPACITY`/`_REFILL_PER_SEC`; over ⇒ close 1008); per-peer 24 MiB in-flight ceiling (`CEILING_BYTES`; over ⇒ close 1013); single message ≤ 32 MiB (`MAX_WS_MESSAGE`).

**Teardown (revocation):** an authed socket sends the single relay-local byte `0xFE` (`UNLINK_INTENT`); the DO closes both peers with 4410 (`UNLINKED`) and `deleteAll()`s. Desktop unpair MUST send this so transport revocation is simultaneous with the device-key delete.

**Close-code vocabulary:** 1000 normal, 1008 rate-limited, 1013 backpressure, 4400 bad-signal/role-mismatch/unexpected-control, 4401 slot-auth-failed (bad commitment / bad shape / unauthed data), 4404 no-link, 4409 slot-taken (eviction), 4410 unlinked.

**Hibernation/liveness:** the DO uses `setWebSocketAutoResponse('ping' → 'pong')` for cheap edge liveness; this is NOT peer liveness. Units C/D MUST run the E2E `PING`/`PONG` inside the encrypted channel to detect a black-holed direction.
