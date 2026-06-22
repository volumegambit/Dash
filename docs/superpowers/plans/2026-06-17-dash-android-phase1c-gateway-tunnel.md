# Dash Android Phase 1C — Gateway Tunnel-Client + Pairing Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add `apps/gateway/src/tunnel-client.ts` (dial-out relay client + fresh-handshake state machine + chat/management/resume bridges) and the gateway-side **pairing server** (HTTP routes mounted on the management API that create a relay link, surface the QR payload, run the gateway side of the provisioning/ephemeral/key-confirmation handshake, derive the SAS, and atomically commit the phone's static key + slot-secret-hash on SAS confirmation), wired into gateway startup and shutdown.

**Architecture:** The gateway dials OUT to the zero-knowledge relay over WSS, runs the relay-join slot-auth control handshake and then a fresh mutually-authenticated E2E handshake (X25519 + HKDF-SHA256 + IETF ChaCha20-Poly1305) on EVERY connection with NO key persistence, using only `@dash/relay-protocol` exports. Once keyed, it forwards inner frames over the encrypted channel: `CHAT_*` frames bridge to one persistent loopback chat WS at `ws://127.0.0.1:9200/ws/chat?token=`, and `REQ`/`RESP` frames bridge to the loopback management API via `fetch('http://127.0.0.1:9300'…)` with a locally-injected bearer token. The pairing server is a set of Hono routes (`/pairing/*`) mounted on the existing management app that drive the first-time QR pairing and atomically commit on SAS-confirm.

**Tech Stack:** Node.js 22 (ESM, TypeScript strict, ES2024/NodeNext, `.js` local imports), Vitest globals, Biome (2-space, single quotes, semicolons, 100-col, NO `any`), `ws@^8` (already used by `@dash/channels`/`@dash/management`), Hono `^4`, `@dash/relay-protocol` (Unit A — built first), `@dash/logging` (`StructuredLogger`/`Logger`).

---

## Preconditions (read before starting)

1. **Unit A (`@dash/relay-protocol`) MUST be built before any gateway test runs.** The gateway imports `@dash/relay-protocol` by its package name (the workspace symlink in `node_modules` points at the package's `dist/`). Run `npm run build` at the repo root (or `npx tsup` inside `packages/relay-protocol`) before `npm test -- apps/gateway/...`. There is NO vitest alias for `@dash/relay-protocol` in `vitest.config.ts` (only `@dash/management`/`@dash/projects` are aliased to `src`), so the built dist is what tests resolve. If you see `Cannot find package '@dash/relay-protocol'`, you forgot to build Unit A.
2. **Add `@dash/relay-protocol` and `ws` to `apps/gateway/package.json`** in Task 1; `@types/ws` is provided transitively by `ws@^8` (it bundles its own types). The repo already has `ws@^8` resolved (see `packages/channels/package.json:22`, `packages/management/package.json:24`).
3. **The bare specifier is `@dash/relay-protocol`** (the package's `package.json` `name`). NEVER `@relay-protocol`.
4. **Commits in this plan carry NO `Co-Authored-By` line** (project CLAUDE.md forbids it). Stage only the exact files each task lists — never `git add -A`.
5. **Ports:** the spec body and this unit use chat loopback `:9200` and management loopback `:9300` (see `apps/gateway/src/index.ts:38-39` — `managementPort ?? 9300`, `channelPort ?? 9200`). The chat WS path is `/ws/chat` (`apps/gateway/src/chat-ws.ts:142`), auth via `?token=` query param (`chat-ws.ts:146-148`). The management API authenticates via `Authorization: Bearer <token>` (`apps/gateway/src/management-api.ts:240-243`), `/health` exempt (`management-api.ts:236`).

---

## Frozen interfaces THIS unit exposes (Unit D — the CLI harness — depends on these)

These are mounted on the management API (bearer-authenticated like every other management route except `/health`). The CLI harness (`mc-cli pair` / acceptance harness) drives pairing exclusively through them.

```
POST   /pairing/links
  req  body: { label: string }                       // human name for the device row
  resp 201:  {
    linkId: string;                                  // 32 base64url chars
    relayUrl: string;                                // the relay this link lives on
    gatewayStaticPubHex: string;                     // S_g.pub, 64 hex chars
    pskHex: string;                                  // 32-byte psk, 64 hex chars (QR ONLY)
    qrPayload: string;                               // toBase64Url(utf8(JSON.stringify(QrPayloadV1)))
    expiresAt: string;                               // ISO8601 = createdAt + 75s (PENDING_TTL)
  }
  // Side effects: generates linkId+psk, ensures S_g exists, dials the relay as
  // role=gateway, completes relay slot-auth (creates the 'pending' link), and
  // begins driving the gateway side of the E2E pairing handshake in the background.

GET    /pairing/links/:linkId
  resp 200:  {
    linkId: string;
    state: 'awaiting-phone' | 'awaiting-sas' | 'committed' | 'rejected' | 'expired' | 'error';
    sas: string | null;                              // 6 digits once 'awaiting-sas', else null
    deviceLabel: string;
    error: string | null;                            // populated when state==='error'
  }
  resp 404:  { error: 'link not found' }
  // Poll target: the CLI polls until state==='awaiting-sas' (sas non-null), shows
  // the SAS to the user, then POSTs the confirm route.

POST   /pairing/links/:linkId/confirm
  req  body: {}                                      // empty; the desktop user has eyeballed the SAS
  resp 200:  { ok: true; deviceId: string }          // atomic commit done; psk wiped
  resp 409:  { error: 'not awaiting SAS confirmation' }   // wrong state
  resp 404:  { error: 'link not found' }
  // The ONLY path that commits S_p.pub + slotSecretHash to relay:authorized-devices.

POST   /pairing/links/:linkId/reject
  resp 200:  { ok: true }                            // tears down the relay link, wipes psk
  resp 404:  { error: 'link not found' }

QR payload (the bytes the phone scans; relay never sees it):
  interface QrPayloadV1 {
    v: 1;
    relayUrl: string;
    linkId: string;
    gatewayStaticPubHex: string;   // S_g.pub hex
    pskHex: string;                // psk hex
  }
  // Encoded as: toBase64Url(utf8Encode(JSON.stringify(payload))). mc-cli renders
  // this base64url string as an ASCII QR; the phone decodes it symmetrically.
```

Credential-store keys this unit owns (in the existing AES-256-GCM `credentials.enc`, `apps/gateway/src/credential-store.ts`):
- `relay:gateway:static:priv` — S_g private key, 64 hex chars
- `relay:gateway:static:pub` — S_g public key, 64 hex chars
- `relay:authorized-devices` — JSON `Record<deviceId, AuthorizedDevice>`

---

## File Structure

```
apps/gateway/
  package.json                              (Modify: add @dash/relay-protocol + ws deps)
  src/
    tunnel-client.ts                        (Create: dial-out client, handshake, bridges)
    tunnel-client.test.ts                   (Create: unit tests for the above)
    pairing-server.ts                       (Create: PairingManager + QR payload codec)
    pairing-server.test.ts                  (Create: PairingManager + QR codec tests)
    pairing-routes.ts                       (Create: Hono /pairing/* routes over PairingManager)
    pairing-routes.test.ts                  (Create: route contract tests)
    index.ts                                (Modify: mount routes, init/shutdown tunnel-client)
    config.ts                               (Modify: --relay-url flag + relay config)
    config.test.ts                          (Create: parseFlags relay-url test)
```

---

## Module map of `tunnel-client.ts` (what every task adds)

All factory/helper functions in this module type their `logger` parameter as the **narrow `Logger`** interface from `@dash/logging` (`debug`/`info`/`warn`/`error`). `StructuredLogger extends Logger`, so the gateway passing its full `StructuredLogger` satisfies it, and unit tests can pass a plain `{ debug, info, warn, error }` stub. Only `TunnelClientOptions.logger` is typed as the full `StructuredLogger` (Task 9).

- Task 2: `StaticKeyPair`, `getOrCreateStaticKeys` — S_g management in the credential store.
- Task 3: `AuthorizedDevice`, `getAuthorizedDevices`, `addAuthorizedDevice`, `removeAuthorizedDevice` — `relay:authorized-devices`.
- Task 4: `RelayDialer` — WSS dial with timeout + exponential backoff.
- Task 5: `runJoinHandshake` — the relay-join control handshake (JOIN → CHALLENGE → SLOT_AUTH → JOIN_RESULT).
- Task 6: `deriveGatewaySessionKeys` — gateway-perspective ECDH → `deriveSessionKeys`.
- Task 7: `createChatBridge` — one persistent loopback chat WS, CHAT_* ↔ Ws{Client,Server}Message.
- Task 8: `createManagementBridge` — REQ → fetch :9300 → RESP, correlated by streamId.
- Task 9: `TunnelClientOptions`, `TunnelClientHandle`, `initTunnelClient` — the assembled client: dial loop, slot-auth, fresh session handshake against committed devices, encrypted frame pump (seal/open + RecordSeqGuard), heartbeat, resume.

---

## Crypto mapping (load-bearing — get this exactly right)

`deriveSessionKeys` (`@dash/relay-protocol`) takes **gateway-perspective** shared-secret names. The gateway computes:
- `ssEe = diffieHellmanRaw(E_g_priv, E_p_pub)`  — ephemeral·ephemeral (forward secrecy)
- `ssSe = diffieHellmanRaw(S_g_priv, E_p_pub)`  — gateway-static·phone-ephemeral (authenticates the gateway)
- `ssEs = diffieHellmanRaw(E_g_priv, S_p_pub)`  — gateway-ephemeral·phone-static (authenticates the phone)

The transcript is `buildTranscript({ linkId, gwStaticPub, phoneStaticPub, gwEphemeralPub, phoneEphemeralPub, gwNonce, phoneNonce })`. During pairing, `deriveSessionKeys` is called WITH `psk` (folded into the IKM); during every reconnect/session it is called WITHOUT `psk`. Direction is authenticated in the outer AEAD AAD; the per-direction nonce is `[4B zero][8B BE recordSeq]` and `RecordSeqGuard` enforces strict monotonicity on receive. Fresh ephemerals every connection ⇒ fresh keys ⇒ the counter resets to 0 safely.

The gateway is the relay role `Role.GATEWAY` and the outbound data direction is `Direction.GW_TO_PHONE` (sealed with `k_g2p` / `sessionKeys.kG2p`); inbound is `Direction.PHONE_TO_GW` (opened with `k_p2g` / `sessionKeys.kP2g`).

---

## Task 1: Add dependencies to the gateway package

**Files:** Modify `apps/gateway/package.json`

- [ ] **Step 1: Write the failing test**

There is no unit test for `package.json` content; the "test" is a build-resolution check. Create it as a guard so the dependency is provably present:

Create `apps/gateway/src/deps.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('gateway package dependencies', () => {
  it('declares @dash/relay-protocol and ws', async () => {
    const raw = await readFile(resolve(here, '../package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['@dash/relay-protocol']).toBeDefined();
    expect(pkg.dependencies?.ws).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/deps.test.ts
```
Expected: FAIL — `expect(pkg.dependencies?.['@dash/relay-protocol']).toBeDefined()` receives `undefined`.

- [ ] **Step 3: Write minimal implementation**

Edit `apps/gateway/package.json` `dependencies` to add the two entries (keep the existing keys; add these in alphabetical position):

```json
  "dependencies": {
    "@dash/agent": "*",
    "@dash/channels": "*",
    "@dash/mcp": "*",
    "@dash/chat": "*",
    "@dash/logging": "*",
    "@dash/management": "*",
    "@dash/models": "*",
    "@dash/projects": "*",
    "@dash/relay-protocol": "*",
    "@hono/node-server": "^1",
    "@hono/node-ws": "^1",
    "better-sqlite3": "^12.9.0",
    "dotenv": "^16.4.0",
    "hono": "^4",
    "ws": "^8"
  },
```

Then install so the workspace symlink + `ws` resolve:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm install
```
And build Unit A so `@dash/relay-protocol` has a `dist/` (precondition 1):
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm run build --workspace @dash/relay-protocol
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/deps.test.ts
```
Expected: PASS — `1 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/package.json apps/gateway/src/deps.test.ts && git commit -m "feat(gateway): add @dash/relay-protocol and ws deps for tunnel-client"
```

---

## Task 2: Gateway static-key management (`S_g`) in the credential store

**Files:** Create `apps/gateway/src/tunnel-client.ts`, Create `apps/gateway/src/tunnel-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/tunnel-client.test.ts`:

```ts
import type { GatewayCredentialStore } from './credential-store.js';
import { getOrCreateStaticKeys } from './tunnel-client.js';

/** Minimal in-memory stand-in for GatewayCredentialStore's get/set surface. */
function fakeStore(): GatewayCredentialStore {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => {
      map.set(k, v);
    },
    delete: async (k: string) => {
      map.delete(k);
    },
  } as unknown as GatewayCredentialStore;
}

describe('getOrCreateStaticKeys', () => {
  it('generates a 32-byte X25519 keypair on first call and persists it as hex', async () => {
    const store = fakeStore();
    const keys = await getOrCreateStaticKeys(store);
    expect(keys.privateKey.length).toBe(32);
    expect(keys.publicKey.length).toBe(32);
    expect(await store.get('relay:gateway:static:pub')).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get('relay:gateway:static:priv')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same keypair on a second call (recovered from the store)', async () => {
    const store = fakeStore();
    const a = await getOrCreateStaticKeys(store);
    const b = await getOrCreateStaticKeys(store);
    expect(Buffer.from(b.publicKey).toString('hex')).toBe(
      Buffer.from(a.publicKey).toString('hex'),
    );
    expect(Buffer.from(b.privateKey).toString('hex')).toBe(
      Buffer.from(a.privateKey).toString('hex'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — `Failed to resolve import "./tunnel-client.js"` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/gateway/src/tunnel-client.ts`:

```ts
import { generateX25519KeyPair } from '@dash/relay-protocol';
import type { GatewayCredentialStore } from './credential-store.js';

const STATIC_PRIV_KEY = 'relay:gateway:static:priv';
const STATIC_PUB_KEY = 'relay:gateway:static:pub';

/** The gateway long-lived static X25519 keypair (S_g), held as raw 32-byte arrays. */
export interface StaticKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Load the gateway static keypair (S_g) from the credential store, generating
 * and persisting a fresh one on first run. Keys are stored hex-encoded under
 * `relay:gateway:static:{priv,pub}` in the existing AES-256-GCM credential store.
 */
export async function getOrCreateStaticKeys(
  credentialStore: GatewayCredentialStore,
): Promise<StaticKeyPair> {
  const privHex = await credentialStore.get(STATIC_PRIV_KEY);
  const pubHex = await credentialStore.get(STATIC_PUB_KEY);
  if (privHex && pubHex) {
    return { privateKey: hexToBytes(privHex), publicKey: hexToBytes(pubHex) };
  }
  const kp = generateX25519KeyPair();
  await credentialStore.set(STATIC_PRIV_KEY, bytesToHex(kp.privateKey));
  await credentialStore.set(STATIC_PUB_KEY, bytesToHex(kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: kp.publicKey };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): tunnel-client static key (S_g) credential management"
```

---

## Task 3: Authorized-devices management (`relay:authorized-devices`)

**Files:** Modify `apps/gateway/src/tunnel-client.ts`, Modify `apps/gateway/src/tunnel-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/tunnel-client.test.ts`:

```ts
import {
  type AuthorizedDevice,
  addAuthorizedDevice,
  getAuthorizedDevices,
  removeAuthorizedDevice,
} from './tunnel-client.js';

describe('authorized-devices', () => {
  it('returns an empty map when nothing is stored', async () => {
    const store = fakeStore();
    expect(await getAuthorizedDevices(store)).toEqual({});
  });

  it('adds, reads back, and removes a device', async () => {
    const store = fakeStore();
    const device: AuthorizedDevice = {
      deviceId: 'dev-1',
      publicKeyHex: 'aa'.repeat(32),
      slotSecretHashHex: 'bb'.repeat(32),
      label: 'My Phone',
      linkId: 'L'.repeat(32),
      createdAt: '2026-06-17T10:00:00.000Z',
    };
    const added = await addAuthorizedDevice(store, device);
    expect(added['dev-1'].label).toBe('My Phone');
    expect((await getAuthorizedDevices(store))['dev-1'].publicKeyHex).toBe('aa'.repeat(32));
    const after = await removeAuthorizedDevice(store, 'dev-1');
    expect(after['dev-1']).toBeUndefined();
  });

  it('returns an empty map when the stored value is corrupt JSON', async () => {
    const store = fakeStore();
    await store.set('relay:authorized-devices', '{not json');
    expect(await getAuthorizedDevices(store)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — exports `AuthorizedDevice`, `getAuthorizedDevices`, `addAuthorizedDevice`, `removeAuthorizedDevice` do not exist.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/gateway/src/tunnel-client.ts`:

```ts
const AUTHORIZED_DEVICES_KEY = 'relay:authorized-devices';

/** A phone device authorized to reach this gateway through the relay. */
export interface AuthorizedDevice {
  deviceId: string; // unique per pairing
  publicKeyHex: string; // S_p.pub, 64 hex chars
  slotSecretHashHex: string; // sha256(slotSecret), 64 hex chars
  label: string; // user-supplied name
  linkId: string; // the relay linkId this device paired on
  createdAt: string; // ISO8601
}

/** Load the authorized-devices map; empty object on missing or corrupt value. */
export async function getAuthorizedDevices(
  credentialStore: GatewayCredentialStore,
): Promise<Record<string, AuthorizedDevice>> {
  const raw = await credentialStore.get(AUTHORIZED_DEVICES_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, AuthorizedDevice>;
  } catch {
    return {};
  }
}

/** Insert/replace a device and persist. Returns the updated map. */
export async function addAuthorizedDevice(
  credentialStore: GatewayCredentialStore,
  device: AuthorizedDevice,
): Promise<Record<string, AuthorizedDevice>> {
  const devices = await getAuthorizedDevices(credentialStore);
  devices[device.deviceId] = device;
  await credentialStore.set(AUTHORIZED_DEVICES_KEY, JSON.stringify(devices));
  return devices;
}

/** Remove a device by id and persist. Returns the updated map. */
export async function removeAuthorizedDevice(
  credentialStore: GatewayCredentialStore,
  deviceId: string,
): Promise<Record<string, AuthorizedDevice>> {
  const devices = await getAuthorizedDevices(credentialStore);
  delete devices[deviceId];
  await credentialStore.set(AUTHORIZED_DEVICES_KEY, JSON.stringify(devices));
  return devices;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): authorized-devices credential management"
```

---

## Task 4: Relay dialer with timeout + exponential backoff

**Files:** Modify `apps/gateway/src/tunnel-client.ts`, Modify `apps/gateway/src/tunnel-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/tunnel-client.test.ts`:

```ts
import { RelayDialer } from './tunnel-client.js';

describe('RelayDialer', () => {
  it('starts with retryCount 0', () => {
    const d = new RelayDialer('wss://relay.example.com/connect?linkId=x&role=gateway');
    expect(d.retryCount).toBe(0);
  });

  it('grows backoff exponentially and caps at 30s', () => {
    const d = new RelayDialer('wss://relay.example.com/connect?linkId=x&role=gateway');
    d.retryCount = 0;
    expect(d.nextRetryDelay()).toBeLessThanOrEqual(1100); // ~2^0 s + <=10% jitter
    d.retryCount = 10;
    expect(d.nextRetryDelay()).toBe(30000); // base 2^10 s already >30s -> clamp
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — `RelayDialer` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/gateway/src/tunnel-client.ts`. First add the `ws` import to the top import block (keep existing imports):

```ts
import { WebSocket } from 'ws';
```

Then add the class:

```ts
const DIAL_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Dials the relay over WSS with a connect timeout and exponential backoff
 * (capped at 30s, +<=10% jitter). One dialer per connection attempt loop.
 */
export class RelayDialer {
  retryCount = 0;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /** Backoff for the NEXT attempt: min(2^retryCount s, 30s) + up to 10% jitter, clamped to 30s. */
  nextRetryDelay(): number {
    const base = Math.min(2 ** this.retryCount, 30) * 1000;
    const jitter = Math.random() * base * 0.1;
    return Math.min(base + jitter, MAX_BACKOFF_MS);
  }

  /** Open the WSS connection. Resolves the open socket; rejects on error/timeout. */
  dial(): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 33_554_432 }); // 32 MiB = MAX_WS_MESSAGE
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('relay dial timeout'));
      }, DIAL_TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        this.retryCount = 0;
        resolve(ws);
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `7 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): RelayDialer with connect timeout and capped backoff"
```

---

## Task 5: Relay-join slot-auth control handshake (`runJoinHandshake`)

**Files:** Modify `apps/gateway/src/tunnel-client.ts`, Modify `apps/gateway/src/tunnel-client.test.ts`

This runs the control plane against the relay DO: send `JOIN`, await `CHALLENGE`, reply `SLOT_AUTH` (proof = `slotAuthProof(slotSecret, challenge)`, commitment = `slotSecretCommitment(slotSecret)`), await `JOIN_RESULT`. The relay tags the socket with the connect-time role; the JOIN's numeric `Role` must equal it. We test the pure message-handling step driver with a fake socket so no real network is needed.

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/tunnel-client.test.ts`:

```ts
import {
  Role,
  JoinResultCode,
  ControlMsgType,
  decodeJoin,
  decodeSlotAuth,
  encodeChallenge,
  encodeJoinResult,
  peekControlMsgType,
  randomBytes16,
  randomBytes32,
  slotAuthProof,
  slotSecretCommitment,
  bytesEqual,
} from '@dash/relay-protocol';
import { runJoinHandshake, type JoinSocket } from './tunnel-client.js';

/** A scripted JoinSocket: records sent control messages, lets the test push inbound ones. */
function scriptedSocket(): {
  socket: JoinSocket;
  sent: Uint8Array[];
  push: (bytes: Uint8Array) => void;
} {
  const sent: Uint8Array[] = [];
  let onMsg: ((b: Uint8Array) => void) | null = null;
  const socket: JoinSocket = {
    send: (b) => {
      sent.push(b);
    },
    onMessage: (h) => {
      onMsg = h;
    },
    close: () => {},
  };
  return { socket, sent, push: (b) => onMsg?.(b) };
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe('runJoinHandshake', () => {
  it('sends JOIN then SLOT_AUTH(proof, commitment) and resolves OK with peerPresent', async () => {
    const { socket, sent, push } = scriptedSocket();
    const slotSecret = randomBytes32();
    const challenge = randomBytes16();

    const promise = runJoinHandshake({
      socket,
      role: Role.GATEWAY,
      linkId: 'L'.repeat(32),
      slotSecret,
      logger: noopLogger,
    });

    // First sent message must be JOIN.
    expect(peekControlMsgType(sent[0])).toBe(ControlMsgType.JOIN);
    const join = decodeJoin(sent[0]);
    expect(join.role).toBe(Role.GATEWAY);

    // DO replies with a CHALLENGE.
    push(encodeChallenge(challenge));

    // Client must now answer SLOT_AUTH with the correct proof + commitment.
    const slotAuth = decodeSlotAuth(sent[1]);
    expect(bytesEqual(slotAuth.slotProof, slotAuthProof(slotSecret, challenge))).toBe(true);
    expect(bytesEqual(slotAuth.slotSecretHash, slotSecretCommitment(slotSecret))).toBe(true);

    // DO replies with JOIN_RESULT OK.
    push(encodeJoinResult({ code: JoinResultCode.OK, peerPresent: true }));

    const result = await promise;
    expect(result.code).toBe(JoinResultCode.OK);
    expect(result.peerPresent).toBe(true);
  });

  it('rejects when JOIN_RESULT carries a non-OK code', async () => {
    const { socket, push } = scriptedSocket();
    const promise = runJoinHandshake({
      socket,
      role: Role.PHONE,
      linkId: 'L'.repeat(32),
      slotSecret: randomBytes32(),
      logger: noopLogger,
    });
    push(encodeChallenge(randomBytes16()));
    push(encodeJoinResult({ code: JoinResultCode.NO_PENDING_LINK, peerPresent: false }));
    await expect(promise).rejects.toThrow(/join failed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — `runJoinHandshake` / `JoinSocket` are not exported.

- [ ] **Step 3: Write minimal implementation**

First extend the `@dash/relay-protocol` import block at the top of `apps/gateway/src/tunnel-client.ts` to include the control-plane symbols (merge with the existing `generateX25519KeyPair` import — a single import statement listing all used names):

```ts
import {
  ControlMsgType,
  type JoinResultCode,
  JoinResultCode as JoinResultCodeEnum,
  type Role,
  decodeChallenge,
  decodeJoinResult,
  encodeJoin,
  encodeSlotAuth,
  generateX25519KeyPair,
  peekControlMsgType,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';
import type { Logger } from '@dash/logging';
```

> Note: `JoinResultCode` in the contract is BOTH a value object and a type alias. We import the value as `JoinResultCodeEnum` and the type as `JoinResultCode` to use both without a name clash.

Then append:

```ts
/** Transport-agnostic socket surface used by the control handshake. */
export interface JoinSocket {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  close(): void;
}

export interface JoinHandshakeResult {
  code: JoinResultCode;
  peerPresent: boolean;
}

const JOIN_TIMEOUT_MS = 10_000;

/**
 * Run the relay-join control handshake as either role:
 *   client -> JOIN -> [DO] -> CHALLENGE -> client -> SLOT_AUTH -> [DO] -> JOIN_RESULT.
 * Resolves on JoinResultCode.OK; rejects on any other code, a malformed/out-of-order
 * control message, or timeout. Zero-knowledge: the slotSecret never leaves the client;
 * only the HMAC proof + the sha256 commitment are sent.
 */
export function runJoinHandshake(args: {
  socket: JoinSocket;
  role: Role;
  linkId: string;
  slotSecret: Uint8Array;
  logger: Logger;
}): Promise<JoinHandshakeResult> {
  const { socket, role, linkId, slotSecret, logger } = args;
  return new Promise<JoinHandshakeResult>((resolve, reject) => {
    let phase: 'await-challenge' | 'await-result' = 'await-challenge';
    const timer = setTimeout(() => reject(new Error('join handshake timeout')), JOIN_TIMEOUT_MS);

    socket.onMessage((bytes) => {
      let kind: number;
      try {
        kind = peekControlMsgType(bytes);
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      try {
        if (phase === 'await-challenge') {
          if (kind !== ControlMsgType.CHALLENGE) {
            throw new Error(`join failed: expected CHALLENGE, got 0x${kind.toString(16)}`);
          }
          const challenge = decodeChallenge(bytes);
          socket.send(
            encodeSlotAuth({
              role,
              slotProof: slotAuthProof(slotSecret, challenge),
              slotSecretHash: slotSecretCommitment(slotSecret),
            }),
          );
          phase = 'await-result';
          return;
        }
        // phase === 'await-result'
        if (kind !== ControlMsgType.JOIN_RESULT) {
          throw new Error(`join failed: expected JOIN_RESULT, got 0x${kind.toString(16)}`);
        }
        const result = decodeJoinResult(bytes);
        clearTimeout(timer);
        if (result.code !== JoinResultCodeEnum.OK) {
          reject(new Error(`join failed: code 0x${result.code.toString(16)}`));
          return;
        }
        logger.info('tunnel-client: relay slot-auth ok', {
          role,
          peerPresent: result.peerPresent,
        });
        resolve({ code: result.code, peerPresent: result.peerPresent });
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.send(encodeJoin({ role, linkId }));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `9 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): relay-join slot-auth control handshake (runJoinHandshake)"
```

---

## Task 6: Gateway-perspective ECDH → session keys (`deriveGatewaySessionKeys`)

**Files:** Modify `apps/gateway/src/tunnel-client.ts`, Modify `apps/gateway/src/tunnel-client.test.ts`

- [ ] **Step 1: Write the failing test**

This test verifies the gateway's derivation matches a phone-perspective derivation built directly from the contract helpers (so the two sides agree on keys + SAS).

Append to `apps/gateway/src/tunnel-client.test.ts`:

```ts
import {
  buildTranscript,
  deriveSessionKeys,
  diffieHellmanRaw,
  generateX25519KeyPair,
} from '@dash/relay-protocol';
import { deriveGatewaySessionKeys } from './tunnel-client.js';

describe('deriveGatewaySessionKeys', () => {
  it('produces keys + SAS identical to a phone-perspective derivation (session, no psk)', () => {
    const linkId = 'L'.repeat(32);
    const sg = generateX25519KeyPair();
    const sp = generateX25519KeyPair();
    const eg = generateX25519KeyPair();
    const ep = generateX25519KeyPair();
    const gwNonce = new Uint8Array(16).fill(0x11);
    const phoneNonce = new Uint8Array(16).fill(0x22);

    const gw = deriveGatewaySessionKeys({
      linkId,
      gwStaticPriv: sg.privateKey,
      gwStaticPub: sg.publicKey,
      gwEphemeralPriv: eg.privateKey,
      gwEphemeralPub: eg.publicKey,
      gwNonce,
      phoneStaticPub: sp.publicKey,
      phoneEphemeralPub: ep.publicKey,
      phoneNonce,
    });

    // Phone perspective: ssEe = E_p . E_g ; ssSe(gw-static·phone-eph) recomputed
    // by the phone as E_p . S_g ; ssEs(gw-eph·phone-static) as S_p . E_g.
    const transcript = buildTranscript({
      linkId,
      gwStaticPub: sg.publicKey,
      phoneStaticPub: sp.publicKey,
      gwEphemeralPub: eg.publicKey,
      phoneEphemeralPub: ep.publicKey,
      gwNonce,
      phoneNonce,
    });
    const phone = deriveSessionKeys({
      ssEe: diffieHellmanRaw(ep.privateKey, eg.publicKey),
      ssSe: diffieHellmanRaw(ep.privateKey, sg.publicKey),
      ssEs: diffieHellmanRaw(sp.privateKey, eg.publicKey),
      transcript,
    });

    expect(Buffer.from(gw.kG2p).toString('hex')).toBe(Buffer.from(phone.kG2p).toString('hex'));
    expect(Buffer.from(gw.kP2g).toString('hex')).toBe(Buffer.from(phone.kP2g).toString('hex'));
    expect(gw.sas).toBe(phone.sas);
    expect(gw.sas).toMatch(/^[0-9]{6}$/);
  });

  it('folds psk in during pairing so the keys differ from the psk-less derivation', () => {
    const linkId = 'L'.repeat(32);
    const sg = generateX25519KeyPair();
    const sp = generateX25519KeyPair();
    const eg = generateX25519KeyPair();
    const ep = generateX25519KeyPair();
    const args = {
      linkId,
      gwStaticPriv: sg.privateKey,
      gwStaticPub: sg.publicKey,
      gwEphemeralPriv: eg.privateKey,
      gwEphemeralPub: eg.publicKey,
      gwNonce: new Uint8Array(16),
      phoneStaticPub: sp.publicKey,
      phoneEphemeralPub: ep.publicKey,
      phoneNonce: new Uint8Array(16),
    };
    const session = deriveGatewaySessionKeys(args);
    const pairing = deriveGatewaySessionKeys({ ...args, psk: new Uint8Array(32).fill(7) });
    expect(Buffer.from(session.kG2p).toString('hex')).not.toBe(
      Buffer.from(pairing.kG2p).toString('hex'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — `deriveGatewaySessionKeys` is not exported.

- [ ] **Step 3: Write minimal implementation**

Extend the `@dash/relay-protocol` import block to add `buildTranscript`, `deriveSessionKeys`, `diffieHellmanRaw`, and `type SessionKeys`:

```ts
import {
  ControlMsgType,
  type JoinResultCode,
  JoinResultCode as JoinResultCodeEnum,
  type Role,
  type SessionKeys,
  buildTranscript,
  decodeChallenge,
  decodeJoinResult,
  deriveSessionKeys,
  diffieHellmanRaw,
  encodeJoin,
  encodeSlotAuth,
  generateX25519KeyPair,
  peekControlMsgType,
  slotAuthProof,
  slotSecretCommitment,
} from '@dash/relay-protocol';
```

Then append:

```ts
/**
 * Derive the per-connection session keys from the gateway's perspective.
 * gateway-perspective shared secrets (the names `deriveSessionKeys` expects):
 *   ssEe = X25519(E_g_priv, E_p_pub)   ssSe = X25519(S_g_priv, E_p_pub)   ssEs = X25519(E_g_priv, S_p_pub)
 * Pass `psk` ONLY during first-time pairing; omit it on every reconnect.
 */
export function deriveGatewaySessionKeys(args: {
  linkId: string;
  gwStaticPriv: Uint8Array;
  gwStaticPub: Uint8Array;
  gwEphemeralPriv: Uint8Array;
  gwEphemeralPub: Uint8Array;
  gwNonce: Uint8Array;
  phoneStaticPub: Uint8Array;
  phoneEphemeralPub: Uint8Array;
  phoneNonce: Uint8Array;
  psk?: Uint8Array;
}): SessionKeys {
  const transcript = buildTranscript({
    linkId: args.linkId,
    gwStaticPub: args.gwStaticPub,
    phoneStaticPub: args.phoneStaticPub,
    gwEphemeralPub: args.gwEphemeralPub,
    phoneEphemeralPub: args.phoneEphemeralPub,
    gwNonce: args.gwNonce,
    phoneNonce: args.phoneNonce,
  });
  return deriveSessionKeys({
    ssEe: diffieHellmanRaw(args.gwEphemeralPriv, args.phoneEphemeralPub),
    ssSe: diffieHellmanRaw(args.gwStaticPriv, args.phoneEphemeralPub),
    ssEs: diffieHellmanRaw(args.gwEphemeralPriv, args.phoneStaticPub),
    transcript,
    psk: args.psk,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `11 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): gateway-perspective session key derivation"
```

---

## Task 7: Chat bridge — one persistent loopback WS, CHAT_* ↔ Ws{Client,Server}Message

**Files:** Modify `apps/gateway/src/tunnel-client.ts`, Modify `apps/gateway/src/tunnel-client.test.ts`

The chat-ws server speaks JSON `WsClientMessage`/`WsServerMessage` (see `apps/gateway/src/chat-ws.ts:43-59`). `WsClientMessage` is `{ type:'message'; id; agentId; channelId; conversationId; text; images?; streamingBehavior? } | { type:'cancel'; id }`. `WsServerMessage` is `{ type:'event'; id; seq?; event } | { type:'done'; id; seq? } | { type:'error'; id; seq?; error }`. The bridge owns one loopback WS and exposes typed send/receive; the live driver (Task 9) maps these to/from `CHAT_*` opcodes.

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/tunnel-client.test.ts`. We stub the global `ws` `WebSocket` by injecting a connector, so no real socket is opened.

```ts
import { createChatBridge, type ChatLoopbackSocket } from './tunnel-client.js';

/** A fake loopback chat socket the test fully controls. */
function fakeChatSocket(): {
  socket: ChatLoopbackSocket;
  sent: string[];
  emit: (data: string) => void;
} {
  const sent: string[] = [];
  let handler: ((d: string) => void) | null = null;
  const socket: ChatLoopbackSocket = {
    send: (d) => {
      sent.push(d);
    },
    onMessage: (h) => {
      handler = h;
    },
    onClose: () => {},
    close: () => {},
  };
  return { socket, sent, emit: (d) => handler?.(d) };
}

describe('createChatBridge', () => {
  it('forwards a WsClientMessage as JSON to the loopback', async () => {
    const f = fakeChatSocket();
    const bridge = createChatBridge({
      connect: async () => f.socket,
      logger: noopLogger,
    });
    await bridge.sendClientMessage({
      type: 'message',
      id: 'm1',
      agentId: 'a1',
      channelId: 'phone',
      conversationId: 'c1',
      text: 'hi',
    });
    expect(JSON.parse(f.sent[0])).toMatchObject({ type: 'message', id: 'm1', text: 'hi' });
  });

  it('surfaces a WsServerMessage parsed from the loopback to the sink', async () => {
    const f = fakeChatSocket();
    const received: unknown[] = [];
    const bridge = createChatBridge({
      connect: async () => f.socket,
      logger: noopLogger,
    });
    bridge.onServerMessage((m) => received.push(m));
    await bridge.sendClientMessage({ type: 'cancel', id: 'm1' });
    f.emit(JSON.stringify({ type: 'done', id: 'm1', seq: 5 }));
    expect(received[0]).toEqual({ type: 'done', id: 'm1', seq: 5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — `createChatBridge` / `ChatLoopbackSocket` are not exported.

- [ ] **Step 3: Write minimal implementation**

We mirror the chat-ws message shapes locally (they are not exported from `chat-ws.ts`). Append to `apps/gateway/src/tunnel-client.ts`:

```ts
import type { AgentEvent } from '@dash/agent';

interface WsMessageImage {
  mediaType: string;
  data: string;
}

/** Mirror of chat-ws.ts WsClientMessage (kept in sync with apps/gateway/src/chat-ws.ts:43). */
export type ChatClientMessage =
  | {
      type: 'message';
      id: string;
      agentId: string;
      channelId: string;
      conversationId: string;
      text: string;
      images?: WsMessageImage[];
      streamingBehavior?: 'steer' | 'followUp';
    }
  | { type: 'cancel'; id: string };

/** Mirror of chat-ws.ts WsServerMessage (kept in sync with apps/gateway/src/chat-ws.ts:56). */
export type ChatServerMessage =
  | { type: 'event'; id: string; seq?: number; event: AgentEvent }
  | { type: 'done'; id: string; seq?: number }
  | { type: 'error'; id: string; seq?: number; error: string };

/** Transport-agnostic loopback chat socket surface (so tests can inject a fake). */
export interface ChatLoopbackSocket {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface ChatBridge {
  /** Forward a client message (already mapped from CHAT_* by the driver) to the loopback. */
  sendClientMessage(msg: ChatClientMessage): Promise<void>;
  /** Register a sink for server messages streamed back from the loopback. */
  onServerMessage(handler: (msg: ChatServerMessage) => void): void;
  /** Close the loopback chat socket. */
  close(): Promise<void>;
}

/**
 * The default connector dials the loopback chat WS at
 * ws://127.0.0.1:9200/ws/chat?token=<chatToken> and adapts the `ws` socket to
 * ChatLoopbackSocket. Injected in tests so no real network is touched.
 */
export function defaultChatConnector(chatToken: string): () => Promise<ChatLoopbackSocket> {
  return () =>
    new Promise<ChatLoopbackSocket>((resolve, reject) => {
      const url = `ws://127.0.0.1:9200/ws/chat?token=${encodeURIComponent(chatToken)}`;
      const ws = new WebSocket(url, { maxPayload: 33_554_432 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('chat loopback connect timeout'));
      }, 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve({
          send: (data) => ws.send(data),
          onMessage: (handler) =>
            ws.on('message', (d: Buffer) => handler(d.toString('utf-8'))),
          onClose: (handler) => ws.on('close', handler),
          close: () => ws.close(),
        });
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
}

/**
 * One persistent loopback chat WS. Opens lazily on first send, reconnects on
 * the next send after a close. Server messages are parsed and fanned out to
 * every registered sink.
 */
export function createChatBridge(args: {
  connect: () => Promise<ChatLoopbackSocket>;
  logger: Logger;
}): ChatBridge {
  const { connect, logger } = args;
  let socket: ChatLoopbackSocket | null = null;
  let connecting: Promise<ChatLoopbackSocket> | null = null;
  const sinks: Array<(msg: ChatServerMessage) => void> = [];

  async function ensure(): Promise<ChatLoopbackSocket> {
    if (socket) return socket;
    if (connecting) return connecting;
    connecting = connect()
      .then((s) => {
        socket = s;
        connecting = null;
        s.onMessage((data) => {
          try {
            const msg = JSON.parse(data) as ChatServerMessage;
            for (const sink of sinks) sink(msg);
          } catch (err) {
            logger.warn('chat-bridge: bad server message', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
        s.onClose(() => {
          socket = null;
        });
        return s;
      })
      .catch((err) => {
        connecting = null;
        throw err;
      });
    return connecting;
  }

  return {
    async sendClientMessage(msg) {
      const s = await ensure();
      s.send(JSON.stringify(msg));
    },
    onServerMessage(handler) {
      sinks.push(handler);
    },
    async close() {
      if (socket) {
        socket.close();
        socket = null;
      }
      connecting = null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `13 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): loopback chat bridge (CHAT_* mapping surface)"
```

---

## Task 8: Management bridge — REQ → fetch :9300 → RESP (bearer injected locally)

**Files:** Modify `apps/gateway/src/tunnel-client.ts`, Modify `apps/gateway/src/tunnel-client.test.ts`

The phone sends a `REQ` payload `{ method, path, query?, headers?, body? }` (spec opcode `0x20`); the gateway `fetch`es `http://127.0.0.1:9300<path>` with the management bearer injected, and returns a `RESP` payload `{ status, headers?, body? }` (opcode `0x21`). The bearer NEVER traverses the relay (it is added here). We inject `fetch` so the test needs no live server.

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/tunnel-client.test.ts`:

```ts
import { createManagementBridge, type ManagementReq } from './tunnel-client.js';

describe('createManagementBridge', () => {
  it('fetches the loopback management API with a locally-injected bearer and maps the response', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify([{ id: 'a1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const bridge = createManagementBridge({
      managementToken: 'mgmt-tok',
      fetchImpl: fakeFetch,
      logger: noopLogger,
    });
    const req: ManagementReq = { method: 'GET', path: '/agents' };
    const resp = await bridge.handle(req);
    expect(capturedUrl).toBe('http://127.0.0.1:9300/agents');
    expect(capturedAuth).toBe('Bearer mgmt-tok');
    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body ?? '')).toEqual([{ id: 'a1' }]);
  });

  it('returns a 502 RESP when the loopback fetch throws', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('econnrefused');
    };
    const bridge = createManagementBridge({
      managementToken: 'x',
      fetchImpl: failing,
      logger: noopLogger,
    });
    const resp = await bridge.handle({ method: 'GET', path: '/agents' });
    expect(resp.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — `createManagementBridge` / `ManagementReq` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/gateway/src/tunnel-client.ts`:

```ts
/** REQ payload (opcode 0x20) sent by the phone over the encrypted channel. */
export interface ManagementReq {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

/** RESP payload (opcode 0x21) returned to the phone. */
export interface ManagementResp {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface ManagementBridge {
  handle(req: ManagementReq): Promise<ManagementResp>;
}

const MANAGEMENT_BASE = 'http://127.0.0.1:9300';

/**
 * Stateless REQ -> fetch -> RESP bridge to the loopback management API. The
 * management bearer is injected here and NEVER traverses the relay. Any phone-
 * supplied Authorization header is dropped (the local token always wins).
 */
export function createManagementBridge(args: {
  managementToken: string;
  fetchImpl?: typeof fetch;
  logger: Logger;
}): ManagementBridge {
  const { managementToken, logger } = args;
  const doFetch = args.fetchImpl ?? fetch;
  return {
    async handle(req) {
      const query = req.query
        ? `?${new URLSearchParams(req.query).toString()}`
        : '';
      const url = `${MANAGEMENT_BASE}${req.path}${query}`;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) {
        if (k.toLowerCase() === 'authorization') continue; // drop phone-supplied auth
        headers[k] = v;
      }
      headers.Authorization = `Bearer ${managementToken}`;
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers,
          body:
            req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        });
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });
        const body = await res.text();
        return { status: res.status, headers: respHeaders, body };
      } catch (err) {
        logger.warn('mgmt-bridge: loopback fetch failed', {
          path: req.path,
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: 502, body: 'gateway loopback unreachable' };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `15 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): management REQ->fetch->RESP bridge with local bearer injection"
```

---

## Task 9: Assemble `initTunnelClient` — dial loop, session handshake, encrypted frame pump, heartbeat, resume

**Files:** Modify `apps/gateway/src/tunnel-client.ts`, Modify `apps/gateway/src/tunnel-client.test.ts`

This is the public surface mounted in `index.ts`. It owns: a per-connection state machine that (1) dials the relay as `role=gateway` for a committed device's link, (2) runs `runJoinHandshake` (slot-auth), (3) exchanges `EPHEMERAL` handshake frames and runs `deriveGatewaySessionKeys` (NO psk — session mode), (4) performs `KEY_CONFIRM`, (5) pumps frames: seal outbound `GW_TO_PHONE` records with `kG2p` and a monotonic `recordSeq`, open inbound `PHONE_TO_GW` records with `kP2g` guarded by `RecordSeqGuard`, dispatch by opcode, (6) runs app-level PING/PONG heartbeat, and (7) on a fresh handshake, replays missed chat events when the phone sends a `CHAT_ANSWER` resume frame: for each cursor it calls `eventLogStore.readSince(agentId, conversationId, sinceSeq)` and streams the missed events back preserving each entry's `seq`, bound to the per-connection `gwNonce`. The unit test exercises the lifecycle contract and the pure opcode-dispatch helper; the live socket path is exercised end-to-end by Unit D's CLI harness.

Because the full driver needs a relay `WebSocket` + loopback servers, the test targets (a) `initTunnelClient` returning a handle whose `start`/`stop`/`stats` honor the contract without a paired device (idle: dials nothing, `connected:false`), and (b) the exported pure helper `dispatchInboundFrame` that routes a decoded inner frame to the right bridge.

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/tunnel-client.test.ts`:

```ts
import {
  Opcode,
  encodeInnerFrame,
  randomBytes16,
  randomBytes32,
  splitChunks,
  utf8Decode,
  utf8Encode,
} from '@dash/relay-protocol';
import type { EventLogEntry } from './event-log-store.js';
import {
  type ResumeRequest,
  dispatchInboundFrame,
  initTunnelClient,
  replayMissedChatEvents,
} from './tunnel-client.js';

describe('dispatchInboundFrame', () => {
  it('routes a REQ frame to the management bridge and returns a RESP frame', async () => {
    const reqPayload = JSON.stringify({ method: 'GET', path: '/agents' });
    const frame = splitChunks(Opcode.REQ, 7, utf8Encode(reqPayload))[0];
    const out = await dispatchInboundFrame(frame, {
      chat: {
        sendClientMessage: async () => {},
        onServerMessage: () => {},
        close: async () => {},
      },
      mgmt: {
        handle: async () => ({ status: 200, body: '[]' }),
      },
      logger: noopLogger,
    });
    expect(out).not.toBeNull();
    expect(out?.type).toBe(Opcode.RESP);
    expect(out?.streamId).toBe(7);
    const resp = JSON.parse(utf8Decode(out?.payload ?? new Uint8Array()));
    expect(resp.status).toBe(200);
  });

  it('routes a CHAT_START frame to the chat bridge and returns null (replies stream async)', async () => {
    const sent: ChatClientMessage[] = [];
    const start = JSON.stringify({
      type: 'message',
      id: 'm1',
      agentId: 'a1',
      channelId: 'phone',
      conversationId: 'c1',
      text: 'hi',
    });
    const frame = splitChunks(Opcode.CHAT_START, 3, utf8Encode(start))[0];
    const out = await dispatchInboundFrame(frame, {
      chat: {
        sendClientMessage: async (m) => {
          sent.push(m);
        },
        onServerMessage: () => {},
        close: async () => {},
      },
      mgmt: { handle: async () => ({ status: 200 }) },
      logger: noopLogger,
    });
    expect(out).toBeNull();
    expect(sent[0]).toMatchObject({ type: 'message', id: 'm1' });
  });
});

describe('replayMissedChatEvents', () => {
  it('reads via readSince and emits the missed events as CHAT_* frames preserving seq', () => {
    const entries: EventLogEntry[] = [
      {
        seq: 4,
        msgId: 'm1',
        agentId: 'a1',
        conversationId: 'c1',
        timestamp: '2026-06-17T10:00:00.000Z',
        payload: { type: 'event', event: { type: 'text_delta', text: 'hello' } },
      },
      {
        seq: 5,
        msgId: 'm1',
        agentId: 'a1',
        conversationId: 'c1',
        timestamp: '2026-06-17T10:00:01.000Z',
        payload: { type: 'done' },
      },
    ];
    let askedSince = -1;
    const emitted: { opcode: number; seq: number }[] = [];
    const request: ResumeRequest = {
      type: 'resume',
      cursors: [{ agentId: 'a1', conversationId: 'c1', sinceSeq: 3 }],
    };
    replayMissedChatEvents({
      eventLogStore: {
        append: () => 1,
        readSince: (_a, _c, since) => {
          askedSince = since;
          return entries;
        },
        deleteAgent: () => {},
        deleteConversation: () => {},
        close: () => {},
      },
      request,
      gwNonce: randomBytes16(),
      emit: (frame) => {
        const msg = JSON.parse(utf8Decode(frame.payload)) as { seq: number };
        emitted.push({ opcode: frame.type, seq: msg.seq });
      },
      logger: noopLogger,
    });
    expect(askedSince).toBe(3);
    expect(emitted).toEqual([
      { opcode: Opcode.CHAT_EVENT, seq: 4 },
      { opcode: Opcode.CHAT_DONE, seq: 5 },
    ]);
  });

  it('emits nothing when the log has no newer entries', () => {
    const emitted: number[] = [];
    replayMissedChatEvents({
      eventLogStore: {
        append: () => 1,
        readSince: () => [],
        deleteAgent: () => {},
        deleteConversation: () => {},
        close: () => {},
      },
      request: { type: 'resume', cursors: [{ agentId: 'a1', conversationId: 'c1', sinceSeq: 9 }] },
      gwNonce: randomBytes32(),
      emit: (frame) => emitted.push(frame.type),
      logger: noopLogger,
    });
    expect(emitted).toEqual([]);
  });
});

describe('initTunnelClient lifecycle', () => {
  it('start() is a no-op-safe idle when no device is paired; stats reports disconnected', async () => {
    const store = fakeStore();
    const handle = await initTunnelClient({
      relayUrl: 'wss://relay.example.com',
      chatToken: 'ct',
      managementToken: 'mt',
      dataDir: '.',
      logger: noopLogger as unknown as import('@dash/logging').StructuredLogger,
      credentialStore: store,
      eventLogStore: {
        append: () => 1,
        readSince: () => [],
        deleteAgent: () => {},
        deleteConversation: () => {},
        close: () => {},
      },
    });
    await handle.start();
    expect(handle.stats().connected).toBe(false);
    await handle.stop();
    expect(handle.stats().connected).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: FAIL — `dispatchInboundFrame` / `initTunnelClient` are not exported.

- [ ] **Step 3: Write minimal implementation**

Extend the `@dash/relay-protocol` import block to add the data-plane symbols, and add the logging + local type imports. The full import block at the top of `apps/gateway/src/tunnel-client.ts` becomes:

```ts
import type { AgentEvent } from '@dash/agent';
import type { Logger, StructuredLogger } from '@dash/logging';
import {
  ChunkReassembler,
  ControlMsgType,
  Direction,
  HandshakeMsgType,
  type InnerFrame,
  type JoinResultCode,
  JoinResultCode as JoinResultCodeEnum,
  Opcode,
  type OuterHeader,
  PROTO_VER,
  RecordSeqGuard,
  type Role,
  Role as RoleEnum,
  type SessionKeys,
  buildTranscript,
  bytesEqual,
  decodeChallenge,
  decodeEphemeral,
  decodeInnerFrame,
  decodeJoinResult,
  decodeKeyConfirm,
  deriveSessionKeys,
  diffieHellmanRaw,
  encodeEphemeral,
  encodeInnerFrame,
  encodeJoin,
  encodeKeyConfirm,
  encodeSlotAuth,
  generateX25519KeyPair,
  openRecord,
  peekControlMsgType,
  peekHandshakeMsgType,
  randomBytes16,
  sealRecord,
  slotAuthProof,
  slotSecretCommitment,
  splitChunks,
  utf8Decode,
  utf8Encode,
} from '@dash/relay-protocol';
import { WebSocket } from 'ws';
import type { EventLogStore } from './event-log-store.js';
import type { GatewayCredentialStore } from './credential-store.js';
```

> Remove the now-duplicated standalone `import { WebSocket } from 'ws';` and the earlier partial relay-protocol import added in Tasks 2/5/6/7 — consolidate into this one block (Biome's `organizeImports` will merge them, but do it by hand to keep the diff clean).

Then append the dispatcher and the driver. First the bridge-shaped dependency interfaces (structural — the real bridges from Tasks 7/8 satisfy them):

```ts
/** Dispatch one decoded inbound inner frame. Returns a RESP frame to send back, or null. */
export async function dispatchInboundFrame(
  frame: InnerFrame,
  deps: {
    chat: Pick<ChatBridge, 'sendClientMessage'>;
    mgmt: ManagementBridge;
    logger: Logger;
  },
): Promise<InnerFrame | null> {
  switch (frame.type) {
    case Opcode.CHAT_START:
    case Opcode.CHAT_CANCEL:
    case Opcode.CHAT_ANSWER: {
      try {
        const msg = JSON.parse(utf8Decode(frame.payload)) as ChatClientMessage;
        await deps.chat.sendClientMessage(msg);
      } catch (err) {
        deps.logger.warn('tunnel-client: bad chat frame', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
    case Opcode.REQ: {
      let req: ManagementReq;
      try {
        req = JSON.parse(utf8Decode(frame.payload)) as ManagementReq;
      } catch (err) {
        deps.logger.warn('tunnel-client: bad REQ frame', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      const resp = await deps.mgmt.handle(req);
      return splitChunks(Opcode.RESP, frame.streamId, utf8Encode(JSON.stringify(resp)))[0];
    }
    default:
      deps.logger.debug('tunnel-client: ignoring inbound opcode', { opcode: frame.type });
      return null;
  }
}

export interface TunnelClientOptions {
  relayUrl: string;
  chatToken: string;
  managementToken: string;
  dataDir: string;
  logger: StructuredLogger;
  credentialStore: GatewayCredentialStore;
  eventLogStore: EventLogStore;
}

export interface TunnelClientStats {
  connected: boolean;
  uptimeMs: number;
  errors: number;
}

export interface TunnelClientHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  stats(): TunnelClientStats;
}

function relayConnectUrl(relayUrl: string, linkId: string, role: 'gateway' | 'phone'): string {
  const base = relayUrl.replace(/\/+$/, '');
  return `${base}/connect?linkId=${encodeURIComponent(linkId)}&role=${role}`;
}

/** Adapt a `ws` WebSocket to the JoinSocket binary control surface. */
function asJoinSocket(ws: WebSocket): JoinSocket {
  return {
    send: (bytes) => ws.send(bytes),
    onMessage: (handler) =>
      ws.on('message', (data: Buffer) => handler(new Uint8Array(data))),
    close: () => ws.close(),
  };
}

/**
 * Initialize the gateway tunnel-client. The returned handle drives a reconnect
 * loop against the FIRST committed device's link (fresh, psk-less handshake on
 * every connection — no key persistence). When no device is paired yet, the
 * loop idles (the pairing server owns the first connection). The frame pump
 * seals GW_TO_PHONE records with kG2p and opens PHONE_TO_GW records with kP2g
 * under a per-direction RecordSeqGuard; CHAT_* bridges to :9200, REQ/RESP to
 * :9300. App-level PING/PONG (25s idle, 2 missed -> teardown) detects a relay
 * black-holing one direction. After a fresh handshake, when the phone sends a
 * CHAT_ANSWER resume frame the client replays the chat events it missed via
 * eventLogStore.readSince (preserving seq), bound to the per-connection gwNonce.
 */
export async function initTunnelClient(
  opts: TunnelClientOptions,
): Promise<TunnelClientHandle> {
  const { relayUrl, chatToken, managementToken, logger, credentialStore, eventLogStore } = opts;
  let stopRequested = false;
  let startedAt = 0;
  let errors = 0;
  let activeWs: WebSocket | null = null;
  let connected = false;
  let loopPromise: Promise<void> | null = null;

  const staticKeys = await getOrCreateStaticKeys(credentialStore);
  const chat = createChatBridge({ connect: defaultChatConnector(chatToken), logger });
  const mgmt = createManagementBridge({ managementToken, logger });

  /** Run one full connection against a committed device's link. Resolves when the socket closes. */
  async function runConnection(device: AuthorizedDevice): Promise<void> {
    const dialer = new RelayDialer(relayConnectUrl(relayUrl, device.linkId, 'gateway'));
    const ws = await dialer.dial();
    activeWs = ws;

    // The relay slotSecret for the gateway slot is the gateway static key's
    // sha256-domain secret: we reuse a deterministic per-link gateway slot
    // secret stored alongside the device. (The phone's slotSecret is the
    // phone's; the gateway proves its OWN slot.) Recover or create it.
    const gwSlotSecret = await getOrCreateGatewaySlotSecret(credentialStore, device.linkId);

    // Buffer binary messages until the join handshake's onMessage is wired.
    const join = asJoinSocket(ws);
    await runJoinHandshake({
      socket: join,
      role: RoleEnum.GATEWAY,
      linkId: device.linkId,
      slotSecret: gwSlotSecret,
      logger,
    });

    // Detach the join handler: from here the socket carries HANDSHAKE (0x04)
    // data-plane frames then sealed records. Re-bind a single message handler.
    ws.removeAllListeners('message');

    const session = await runSessionHandshake({
      ws,
      device,
      staticKeys,
      logger,
    });
    connected = true;
    logger.info('tunnel-client: session established', { linkId: device.linkId });

    // Resume is driven by the phone: after this fresh handshake it sends a
    // CHAT_ANSWER (0x15) resume frame with its per-conversation cursors, which
    // pumpFrames answers by calling eventLogStore.readSince and streaming the
    // missed events back (preserving seq), bound to this connection's gwNonce.
    await pumpFrames({ ws, session, chat, mgmt, eventLogStore, logger });
    connected = false;
    activeWs = null;
  }

  async function loop(): Promise<void> {
    while (!stopRequested) {
      const devices = await getAuthorizedDevices(credentialStore);
      const device = Object.values(devices)[0];
      if (!device) {
        await delay(2000);
        continue;
      }
      const dialer = new RelayDialer(relayUrl);
      try {
        await runConnection(device);
      } catch (err) {
        errors += 1;
        logger.warn('tunnel-client: connection ended', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (stopRequested) break;
      await delay(dialer.nextRetryDelay());
    }
  }

  return {
    async start() {
      if (startedAt) return;
      startedAt = Date.now();
      loopPromise = loop().catch((err) => {
        logger.error(
          'tunnel-client: loop crashed',
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    },
    async stop() {
      stopRequested = true;
      if (activeWs) {
        activeWs.close();
        activeWs = null;
      }
      await chat.close();
      connected = false;
      if (loopPromise) await loopPromise;
    },
    stats() {
      return {
        connected,
        uptimeMs: startedAt ? Date.now() - startedAt : 0,
        errors,
      };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

Now add the per-connection helpers the driver calls — these are real implementations, no placeholders. Append:

```ts
/** Credential-store key prefix for the per-link gateway slot secret. */
export const GW_SLOT_PREFIX = 'relay:gateway:slot:';

/** Credential-store key for a given link's gateway slot secret. */
export function gatewaySlotSecretKey(linkId: string): string {
  return `${GW_SLOT_PREFIX}${linkId}`;
}

/**
 * Per-link gateway slot secret (proves the gateway slot to the relay). The
 * pairing server (Task 11) MUST have persisted this exact secret under
 * `gatewaySlotSecretKey(linkId)` during `createLink`, so reconnect recovers the
 * SAME secret the relay first registered — otherwise the relay rejects the
 * reconnect with a slot-auth failure. The fallback generation here only fires
 * for a link that was committed by an older build with no persisted secret; in
 * that legacy case the relay would have to be re-paired.
 */
async function getOrCreateGatewaySlotSecret(
  credentialStore: GatewayCredentialStore,
  linkId: string,
): Promise<Uint8Array> {
  const key = gatewaySlotSecretKey(linkId);
  const existing = await credentialStore.get(key);
  if (existing) return new Uint8Array(Buffer.from(existing, 'hex'));
  const secret = generateX25519KeyPair().privateKey; // 32 CSPRNG bytes
  await credentialStore.set(key, Buffer.from(secret).toString('hex'));
  return secret;
}

interface EstablishedSession {
  keys: SessionKeys;
  gwNonce: Uint8Array;
  sendSeq: bigint;
  recvGuard: RecordSeqGuard;
}

/**
 * Run the session-mode E2E handshake over an already slot-authed relay socket:
 * send our EPHEMERAL (E_g.pub + gwNonce), receive the phone's EPHEMERAL, derive
 * session keys WITHOUT psk, then exchange KEY_CONFIRM. The phone's static key is
 * the committed device's registered S_p.pub (authentication rests on ssEs/ssSe).
 *
 * The KEY_CONFIRM exchange runs on EVERY connection — pairing AND every
 * reconnect. The gateway sends cfm_g (after deriving keys) and REQUIRES the
 * phone's cfm_p before the session is considered established; the phone applies
 * the symmetric rule (sends cfm_p, requires cfm_g) on every connection. Because
 * the gate waits for cfm_p, a phone (Unit D's CLI harness fake included) that
 * omits cfm_p on reconnect would deadlock the handshake until it times out —
 * so the phone MUST send cfm_p every connection, not only during pairing.
 */
function runSessionHandshake(args: {
  ws: WebSocket;
  device: AuthorizedDevice;
  staticKeys: StaticKeyPair;
  logger: Logger;
}): Promise<EstablishedSession> {
  const { ws, device, staticKeys, logger } = args;
  return new Promise<EstablishedSession>((resolve, reject) => {
    const eg = generateX25519KeyPair();
    const gwNonce = randomBytes16();
    const phoneStaticPub = new Uint8Array(Buffer.from(device.publicKeyHex, 'hex'));
    const reassembler = new ChunkReassembler();
    let keys: SessionKeys | null = null;
    let phoneConfirmSeen = false;

    const timer = setTimeout(() => reject(new Error('session handshake timeout')), 10_000);

    const sendHandshakeFrame = (payload: Uint8Array): void => {
      const frames = splitChunks(Opcode.HANDSHAKE, 0, payload);
      for (const f of frames) ws.send(encodeInnerFrame(f));
    };

    ws.on('message', (data: Buffer) => {
      let inner: InnerFrame;
      try {
        inner = decodeInnerFrame(new Uint8Array(data));
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (inner.type !== Opcode.HANDSHAKE) return; // ignore non-handshake during this phase
      let assembled: Uint8Array | null;
      try {
        assembled = reassembler.push(inner);
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!assembled) return;

      try {
        const kind = peekHandshakeMsgType(assembled);
        if (kind === HandshakeMsgType.EPHEMERAL) {
          const eph = decodeEphemeral(assembled);
          keys = deriveGatewaySessionKeys({
            linkId: device.linkId,
            gwStaticPriv: staticKeys.privateKey,
            gwStaticPub: staticKeys.publicKey,
            gwEphemeralPriv: eg.privateKey,
            gwEphemeralPub: eg.publicKey,
            gwNonce,
            phoneStaticPub,
            phoneEphemeralPub: eph.ephemeralPub,
            phoneNonce: eph.connNonce,
          });
          // Send our key-confirmation (cfm_g).
          sendHandshakeFrame(encodeKeyConfirm({ confirm: keys.cfmG }));
        } else if (kind === HandshakeMsgType.KEY_CONFIRM) {
          if (!keys) throw new Error('key-confirm before ephemeral');
          const confirm = decodeKeyConfirm(assembled);
          // Constant-time compare of the phone's cfm_p against our derived value.
          if (!bytesEqual(confirm.confirm, keys.cfmP)) {
            throw new Error('phone key-confirmation mismatch');
          }
          phoneConfirmSeen = true;
        }
        if (keys && phoneConfirmSeen) {
          clearTimeout(timer);
          ws.removeAllListeners('message');
          logger.info('tunnel-client: key confirmation complete');
          resolve({
            keys,
            gwNonce,
            sendSeq: 0n,
            recvGuard: new RecordSeqGuard(),
          });
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Kick off: advertise our ephemeral + gwNonce.
    sendHandshakeFrame(encodeEphemeral({ ephemeralPub: eg.publicKey, connNonce: gwNonce }));
  });
}

const HEARTBEAT_IDLE_MS = 25_000;
const MAX_MISSED_PONGS = 2;

/**
 * Pump frames over the keyed socket until it closes. Seals outbound GW_TO_PHONE
 * records with kG2p (monotonic recordSeq); opens inbound PHONE_TO_GW records
 * with kP2g (RecordSeqGuard); dispatches by opcode; bridges chat server messages
 * back as CHAT_EVENT/CHAT_DONE/CHAT_ERROR; runs app-level PING/PONG heartbeat.
 * A phone CHAT_ANSWER (0x15) resume frame triggers eventLogStore.readSince and
 * streams the missed events back (preserving seq) instead of going to the chat
 * bridge.
 */
function pumpFrames(args: {
  ws: WebSocket;
  session: EstablishedSession;
  chat: ChatBridge;
  mgmt: ManagementBridge;
  eventLogStore: EventLogStore;
  logger: Logger;
}): Promise<void> {
  const { ws, session, chat, mgmt, eventLogStore, logger } = args;
  return new Promise<void>((resolve) => {
    const reassembler = new ChunkReassembler();
    let missedPongs = 0;

    const sealAndSend = (frame: InnerFrame): void => {
      const header: OuterHeader = {
        protoVer: PROTO_VER,
        direction: Direction.GW_TO_PHONE,
        recordSeq: session.sendSeq,
      };
      const sealed = sealRecord(session.keys.kG2p, header, encodeInnerFrame(frame));
      session.sendSeq += 1n;
      ws.send(sealed.bytes);
    };

    // Bridge chat server events back to the phone as CHAT_* frames.
    chat.onServerMessage((msg) => {
      const opcode =
        msg.type === 'event'
          ? Opcode.CHAT_EVENT
          : msg.type === 'done'
            ? Opcode.CHAT_DONE
            : Opcode.CHAT_ERROR;
      const streamId = chatStreamIdForId(msg.id);
      for (const f of splitChunks(opcode, streamId, utf8Encode(JSON.stringify(msg)))) {
        sealAndSend(f);
      }
    });

    const heartbeat = setInterval(() => {
      if (missedPongs >= MAX_MISSED_PONGS) {
        logger.warn('tunnel-client: peer heartbeat lost, tearing down');
        clearInterval(heartbeat);
        ws.close(1000, 'heartbeat lost');
        return;
      }
      missedPongs += 1;
      sealAndSend(splitChunks(Opcode.PING, 0, new Uint8Array())[0]);
    }, HEARTBEAT_IDLE_MS);

    ws.on('message', (data: Buffer) => {
      let opened: { header: OuterHeader; innerFrameBytes: Uint8Array };
      try {
        opened = openRecord(session.keys.kP2g, new Uint8Array(data), Direction.PHONE_TO_GW);
      } catch (err) {
        logger.warn('tunnel-client: drop unopenable record', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!session.recvGuard.accept(opened.header.recordSeq)) {
        logger.warn('tunnel-client: drop replayed/regressed record', {
          recordSeq: opened.header.recordSeq.toString(),
        });
        return;
      }
      let inner: InnerFrame;
      try {
        inner = decodeInnerFrame(opened.innerFrameBytes);
      } catch (err) {
        logger.warn('tunnel-client: drop undecodable inner frame', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (inner.type === Opcode.PONG) {
        missedPongs = 0;
        return;
      }
      if (inner.type === Opcode.PING) {
        sealAndSend(splitChunks(Opcode.PONG, 0, new Uint8Array())[0]);
        return;
      }

      let assembled: Uint8Array | null;
      try {
        assembled = reassembler.push(inner);
      } catch (err) {
        logger.warn('tunnel-client: chunk error', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!assembled) return;
      const logical: InnerFrame = {
        ver: inner.ver,
        type: inner.type,
        flags: inner.flags,
        streamId: inner.streamId,
        chunkIndex: 0,
        payload: assembled,
      };

      // Resume: a CHAT_ANSWER (0x15) carrying { type:'resume', cursors } is the
      // phone catching up after a fresh handshake. Stream the missed events from
      // the durable log (preserving seq) rather than forwarding to the chat WS.
      if (logical.type === Opcode.CHAT_ANSWER) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(utf8Decode(logical.payload));
        } catch (err) {
          logger.warn('tunnel-client: bad CHAT_ANSWER frame', {
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        if (isResumeRequest(parsed)) {
          replayMissedChatEvents({
            eventLogStore,
            request: parsed,
            gwNonce: session.gwNonce,
            emit: sealAndSend,
            logger,
          });
          return;
        }
      }

      dispatchInboundFrame(logical, { chat, mgmt, logger })
        .then((respFrame) => {
          if (respFrame) sealAndSend(respFrame);
        })
        .catch((err) => {
          logger.warn('tunnel-client: dispatch error', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      resolve();
    });
    ws.on('error', () => {
      clearInterval(heartbeat);
      resolve();
    });
  });
}

/** Derive a stable numeric streamId from a chat message id (gateway-initiated => EVEN). */
function chatStreamIdForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (h & 0x7fffffe) | 0; // force even, fits uint31
}

/** One resume cursor the phone supplies for a conversation it wants caught up. */
export interface ResumeCursor {
  agentId: string;
  conversationId: string;
  sinceSeq: number;
}

/** The phone's resume request, carried in a CHAT_ANSWER (0x15) data-plane frame. */
export interface ResumeRequest {
  type: 'resume';
  cursors: ResumeCursor[];
}

/** True when a decoded CHAT_ANSWER payload is a resume request (vs a tool answer). */
export function isResumeRequest(value: unknown): value is ResumeRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'resume' &&
    Array.isArray((value as { cursors?: unknown }).cursors)
  );
}

/**
 * Resume: replay every chat event the phone missed. The phone sends a
 * CHAT_ANSWER (0x15) resume frame after the fresh handshake carrying one cursor
 * per conversation (`sinceSeq` = the last seq it durably saw). For each cursor
 * we call `eventLogStore.readSince(agentId, conversationId, sinceSeq)` and re-emit
 * every newer entry, PRESERVING its original `seq`, as a CHAT_EVENT / CHAT_DONE /
 * CHAT_ERROR frame via `emit`. Replay is safe across sessions because the fresh
 * per-connection keys (bound to this connection's gwNonce) mean a cursor replayed
 * into another session decrypts under a different kP2g and is dropped by openRecord.
 */
export function replayMissedChatEvents(args: {
  eventLogStore: EventLogStore;
  request: ResumeRequest;
  gwNonce: Uint8Array;
  emit: (frame: InnerFrame) => void;
  logger: Logger;
}): void {
  const { eventLogStore, request, emit, logger } = args;
  for (const cursor of request.cursors) {
    const entries = eventLogStore.readSince(
      cursor.agentId,
      cursor.conversationId,
      cursor.sinceSeq,
    );
    for (const entry of entries) {
      const payload = entry.payload;
      const opcode =
        payload.type === 'event'
          ? Opcode.CHAT_EVENT
          : payload.type === 'done'
            ? Opcode.CHAT_DONE
            : Opcode.CHAT_ERROR;
      // Preserve the original per-conversation seq so the phone can advance its
      // resume cursor exactly as if the events had streamed live.
      const serverMsg =
        payload.type === 'event'
          ? { type: 'event' as const, id: entry.msgId, seq: entry.seq, event: payload.event }
          : payload.type === 'done'
            ? { type: 'done' as const, id: entry.msgId, seq: entry.seq }
            : { type: 'error' as const, id: entry.msgId, seq: entry.seq, error: payload.error };
      const streamId = chatStreamIdForId(entry.msgId);
      for (const frame of splitChunks(opcode, streamId, utf8Encode(JSON.stringify(serverMsg)))) {
        emit(frame);
      }
    }
    logger.debug('tunnel-client: resume replayed conversation', {
      agentId: cursor.agentId,
      conversationId: cursor.conversationId,
      sinceSeq: cursor.sinceSeq,
      replayed: entries.length,
      gwNonce: Buffer.from(args.gwNonce).toString('hex').slice(0, 8),
    });
  }
}
```

> Implementation notes that prevent the prior draft's bugs:
> 1. NO `any` anywhere — every parameter is typed; `JSON.parse` results are cast to the local mirror types (`ChatClientMessage`/`ManagementReq`/`ManagementResp`/`ResumeRequest`).
> 2. NO placeholder bodies — `pumpFrames`, `runSessionHandshake`, `replayMissedChatEvents`, and `dispatchInboundFrame` are complete and exercised.
> 3. Every `@dash/relay-protocol` symbol is imported by EXACT name from `@dash/relay-protocol` (never `@relay-protocol`).
> 4. `RecordSeqGuard` is constructed `new RecordSeqGuard()` and used on the receive path; `sendSeq` advances strictly per the encrypt-side invariant.
> 5. Slot-secret continuity: `getOrCreateGatewaySlotSecret` reads the SAME `gatewaySlotSecretKey(linkId)` the pairing server (Task 11) persisted during `createLink`, so reconnect proves the relay's gateway slot with the secret the relay first registered — no fresh-secret regression that would make the relay reject every reconnect.
> 6. Key-confirmation runs on EVERY connection: the gateway sends `cfm_g` and verifies the phone's `cfm_p` (constant-time `bytesEqual`) before the session is established; the phone must send `cfm_p` on every reconnect or the handshake deadlocks until timeout.
> 7. Resume is real, not a no-op: a `CHAT_ANSWER` resume frame triggers `eventLogStore.readSince` per cursor and streams every missed entry back preserving its `seq`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/tunnel-client.test.ts
```
Expected: PASS — `20 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/tunnel-client.ts apps/gateway/src/tunnel-client.test.ts && git commit -m "feat(gateway): assemble initTunnelClient (dial loop, session handshake, frame pump, heartbeat, resume)"
```

---

## Task 10: QR payload codec (`encodeQrPayload` / `decodeQrPayload`)

**Files:** Create `apps/gateway/src/pairing-server.ts`, Create `apps/gateway/src/pairing-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/pairing-server.test.ts`:

```ts
import { decodeQrPayload, encodeQrPayload, type QrPayloadV1 } from './pairing-server.js';

describe('QR payload codec', () => {
  it('round-trips a v1 payload through base64url(JSON)', () => {
    const payload: QrPayloadV1 = {
      v: 1,
      relayUrl: 'wss://relay.dash.example',
      linkId: 'L'.repeat(32),
      gatewayStaticPubHex: 'ab'.repeat(32),
      pskHex: 'cd'.repeat(32),
    };
    const encoded = encodeQrPayload(payload);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(decodeQrPayload(encoded)).toEqual(payload);
  });

  it('rejects a payload with the wrong version', () => {
    const bad = Buffer.from(JSON.stringify({ v: 2 })).toString('base64url');
    expect(() => decodeQrPayload(bad)).toThrow(/unsupported QR payload version/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-server.test.ts
```
Expected: FAIL — `./pairing-server.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/gateway/src/pairing-server.ts`:

```ts
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '@dash/relay-protocol';

/** The bytes the phone scans. The relay never sees this; it is purely out-of-band. */
export interface QrPayloadV1 {
  v: 1;
  relayUrl: string;
  linkId: string;
  gatewayStaticPubHex: string;
  pskHex: string;
}

/** Encode a QR payload as base64url(utf8(JSON)). */
export function encodeQrPayload(payload: QrPayloadV1): string {
  return toBase64Url(utf8Encode(JSON.stringify(payload)));
}

/** Decode a base64url(utf8(JSON)) QR payload. Throws on bad version. */
export function decodeQrPayload(encoded: string): QrPayloadV1 {
  const parsed = JSON.parse(utf8Decode(fromBase64Url(encoded))) as QrPayloadV1;
  if (parsed.v !== 1) {
    throw new Error(`unsupported QR payload version: ${String((parsed as { v: unknown }).v)}`);
  }
  return parsed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-server.test.ts
```
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/pairing-server.ts apps/gateway/src/pairing-server.test.ts && git commit -m "feat(gateway): pairing QR payload codec"
```

---

## Task 11: PairingManager — link creation, state machine, atomic commit

**Files:** Modify `apps/gateway/src/pairing-server.ts`, Modify `apps/gateway/src/pairing-server.test.ts`

`PairingManager` is the headless engine the routes drive. It owns in-memory pairing sessions keyed by `linkId`, generates `linkId`/`psk`, exposes the QR payload, and atomically commits on SAS confirm. The relay-side connection (dial + slot-auth + E2E handshake to the phone) is injected as a `PairingTransport` so the manager is unit-testable without a network. We test creation, the state transitions a transport drives (`onPhoneProvisioned` → `onPhoneEphemeral` derives SAS → `awaiting-sas`), and that `confirm` commits + wipes psk while `reject` tears down.

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/pairing-server.test.ts`:

```ts
import type { GatewayCredentialStore } from './credential-store.js';
import {
  PairingManager,
  type PairingTransport,
  type PairingTransportEvents,
} from './pairing-server.js';
import { getAuthorizedDevices } from './tunnel-client.js';
import {
  generateX25519KeyPair,
  randomBytes16,
  randomBytes32,
  pairingProvisionTag,
  slotSecretCommitment,
  buildTranscript,
  deriveSessionKeys,
  diffieHellmanRaw,
} from '@dash/relay-protocol';

function fakeStore(): GatewayCredentialStore {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => {
      map.set(k, v);
    },
    delete: async (k: string) => {
      map.delete(k);
    },
  } as unknown as GatewayCredentialStore;
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A fake transport that captures the events callback and records teardown. */
function fakeTransport(): {
  transport: PairingTransport;
  fire: PairingTransportEvents;
  torndown: boolean[];
} {
  const torndown: boolean[] = [];
  let events: PairingTransportEvents | null = null;
  const transport: PairingTransport = {
    async connect(_args, ev) {
      events = ev;
    },
    sendEphemeral() {},
    sendKeyConfirm() {},
    async teardown() {
      torndown.push(true);
    },
  };
  // `fire` proxies to whatever the manager registered.
  const fire: PairingTransportEvents = {
    onPhoneProvisioned: (m) => events?.onPhoneProvisioned(m),
    onPhoneEphemeral: (m) => events?.onPhoneEphemeral(m),
    onError: (e) => events?.onError(e),
  };
  return { transport, fire, torndown };
}

describe('PairingManager', () => {
  it('creates a link with linkId/psk and a decodable QR payload', async () => {
    const store = fakeStore();
    const mgr = new PairingManager({
      store,
      transport: fakeTransport().transport,
      relayUrl: 'wss://relay.example',
      logger: noopLogger,
    });
    const link = await mgr.createLink('My Phone');
    expect(link.linkId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(link.pskHex).toMatch(/^[0-9a-f]{64}$/);
    expect(mgr.getStatus(link.linkId)?.state).toBe('awaiting-phone');
    // The gateway slot secret is persisted under the key the tunnel-client's
    // reconnect path reads, so reconnect proves the SAME slot the relay
    // registered during pairing (regression guard for the pairing/reconnect
    // slot-secret seam).
    expect(await store.get(`relay:gateway:slot:${link.linkId}`)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drives provisioning -> ephemeral -> awaiting-sas, then commits on confirm and wipes psk', async () => {
    const store = fakeStore();
    const ft = fakeTransport();
    const mgr = new PairingManager({
      store,
      transport: ft.transport,
      relayUrl: 'wss://relay.example',
      logger: noopLogger,
    });
    const link = await mgr.createLink('My Phone');

    // The phone side (the test plays the phone). It has S_p, slotSecret, E_p.
    const sp = generateX25519KeyPair();
    const ep = generateX25519KeyPair();
    const slotSecret = randomBytes32();
    const phoneNonce = randomBytes16();
    const gwStaticPub = new Uint8Array(Buffer.from(link.gatewayStaticPubHex, 'hex'));
    const psk = new Uint8Array(Buffer.from(link.pskHex, 'hex'));

    // 1) PROVISION: phonePub + phoneNonce + tag over psk.
    ft.fire.onPhoneProvisioned({
      phonePub: sp.publicKey,
      phoneNonce,
      tag: pairingProvisionTag({
        psk,
        linkId: link.linkId,
        gwStaticPub,
        phoneStaticPub: sp.publicKey,
        phoneNonce,
      }),
      slotSecretHash: slotSecretCommitment(slotSecret),
    });

    // 2) EPHEMERAL: phone's E_p.pub + its connNonce (== phoneNonce here).
    ft.fire.onPhoneEphemeral({ ephemeralPub: ep.publicKey, connNonce: phoneNonce });

    const status = mgr.getStatus(link.linkId);
    expect(status?.state).toBe('awaiting-sas');
    expect(status?.sas).toMatch(/^[0-9]{6}$/);

    // 3) Confirm -> commit.
    const result = await mgr.confirm(link.linkId);
    expect(result.ok).toBe(true);
    const devices = await getAuthorizedDevices(store);
    const dev = Object.values(devices)[0];
    expect(dev.publicKeyHex).toBe(Buffer.from(sp.publicKey).toString('hex'));
    expect(dev.slotSecretHashHex).toBe(
      Buffer.from(slotSecretCommitment(slotSecret)).toString('hex'),
    );
    // psk wiped from the live session.
    expect(mgr.getStatus(link.linkId)?.state).toBe('committed');
  });

  it('rejects a bad provisioning tag (relay swapped S_p)', async () => {
    const store = fakeStore();
    const ft = fakeTransport();
    const mgr = new PairingManager({
      store,
      transport: ft.transport,
      relayUrl: 'wss://relay.example',
      logger: noopLogger,
    });
    const link = await mgr.createLink('My Phone');
    const sp = generateX25519KeyPair();
    ft.fire.onPhoneProvisioned({
      phonePub: sp.publicKey,
      phoneNonce: randomBytes16(),
      tag: new Uint8Array(32), // wrong tag
      slotSecretHash: new Uint8Array(32),
    });
    expect(mgr.getStatus(link.linkId)?.state).toBe('error');
  });

  it('confirm before awaiting-sas returns ok:false', async () => {
    const store = fakeStore();
    const mgr = new PairingManager({
      store,
      transport: fakeTransport().transport,
      relayUrl: 'wss://relay.example',
      logger: noopLogger,
    });
    const link = await mgr.createLink('My Phone');
    const result = await mgr.confirm(link.linkId);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-server.test.ts
```
Expected: FAIL — `PairingManager` / `PairingTransport` / `PairingTransportEvents` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/gateway/src/pairing-server.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Logger } from '@dash/logging';
import {
  type EphemeralMessage,
  type SessionKeys,
  bytesEqual,
  generateX25519KeyPair,
  pairingProvisionTag,
  randomBytes16,
  randomBytes32,
  toBase64Url,
} from '@dash/relay-protocol';
import {
  type AuthorizedDevice,
  type StaticKeyPair,
  addAuthorizedDevice,
  deriveGatewaySessionKeys,
  gatewaySlotSecretKey,
  getOrCreateStaticKeys,
} from './tunnel-client.js';
import type { GatewayCredentialStore } from './credential-store.js';

const PENDING_TTL_MS = 75_000;

/** PROVISION message as received from the phone (opcode 0x04 / discriminator 0x90 + slot hash). */
export interface PhoneProvision {
  phonePub: Uint8Array;
  phoneNonce: Uint8Array;
  tag: Uint8Array;
  slotSecretHash: Uint8Array;
}

/** Events the transport fires back into the PairingManager as the phone progresses. */
export interface PairingTransportEvents {
  onPhoneProvisioned(msg: PhoneProvision): void;
  onPhoneEphemeral(msg: EphemeralMessage): void;
  onError(err: Error): void;
}

/** Injected relay-side transport: dials the relay, runs slot-auth, relays E2E frames. */
export interface PairingTransport {
  connect(
    args: { linkId: string; relayUrl: string; gwSlotSecret: Uint8Array },
    events: PairingTransportEvents,
  ): Promise<void>;
  sendEphemeral(ephemeralPub: Uint8Array, gwNonce: Uint8Array): void;
  sendKeyConfirm(confirm: Uint8Array): void;
  teardown(): Promise<void>;
}

export type PairingState =
  | 'awaiting-phone'
  | 'awaiting-sas'
  | 'committed'
  | 'rejected'
  | 'expired'
  | 'error';

export interface PairingLinkInfo {
  linkId: string;
  relayUrl: string;
  gatewayStaticPubHex: string;
  pskHex: string;
  qrPayload: string;
  expiresAt: string;
}

export interface PairingStatus {
  linkId: string;
  state: PairingState;
  sas: string | null;
  deviceLabel: string;
  error: string | null;
}

interface PairingSession {
  linkId: string;
  label: string;
  state: PairingState;
  psk: Uint8Array | null; // wiped on commit/reject/expire
  gwSlotSecret: Uint8Array;
  gwEphemeral: StaticKeyPair;
  gwNonce: Uint8Array;
  phone: PhoneProvision | null;
  keys: SessionKeys | null;
  deviceId: string | null;
  error: string | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

export class PairingManager {
  private readonly store: GatewayCredentialStore;
  private readonly transport: PairingTransport;
  private readonly relayUrl: string;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, PairingSession>();
  private staticKeys: StaticKeyPair | null = null;

  constructor(args: {
    store: GatewayCredentialStore;
    transport: PairingTransport;
    relayUrl: string;
    logger: Logger;
  }) {
    this.store = args.store;
    this.transport = args.transport;
    this.relayUrl = args.relayUrl;
    this.logger = args.logger;
  }

  /** Generate linkId/psk, ensure S_g, dial the relay, and start the gateway handshake. */
  async createLink(label: string): Promise<PairingLinkInfo> {
    if (!this.staticKeys) {
      this.staticKeys = await getOrCreateStaticKeys(this.store);
    }
    const linkId = toBase64Url(new Uint8Array(randomBytes(24))); // 24 bytes -> 32 base64url chars
    const psk = randomBytes32();
    const gwSlotSecret = randomBytes32();
    const gwEphemeral = generateX25519KeyPair();
    const gwNonce = randomBytes16();

    // Persist the gateway slot secret under the SAME key the tunnel-client's
    // reconnect path reads (`gatewaySlotSecretKey(linkId)`), so every later
    // reconnect proves the relay's gateway slot with the identical secret the
    // relay registered during pairing. Without this, reconnect would generate a
    // fresh secret and the relay would reject the join with a slot-auth failure.
    await this.store.set(gatewaySlotSecretKey(linkId), Buffer.from(gwSlotSecret).toString('hex'));

    const session: PairingSession = {
      linkId,
      label,
      state: 'awaiting-phone',
      psk,
      gwSlotSecret,
      gwEphemeral: { privateKey: gwEphemeral.privateKey, publicKey: gwEphemeral.publicKey },
      gwNonce,
      phone: null,
      keys: null,
      deviceId: null,
      error: null,
      ttlTimer: null,
    };
    this.sessions.set(linkId, session);

    session.ttlTimer = setTimeout(() => {
      if (session.state === 'awaiting-phone' || session.state === 'awaiting-sas') {
        this.fail(session, 'expired');
        void this.transport.teardown();
      }
    }, PENDING_TTL_MS);

    await this.transport.connect(
      { linkId, relayUrl: this.relayUrl, gwSlotSecret },
      {
        onPhoneProvisioned: (m) => this.handleProvision(session, m),
        onPhoneEphemeral: (m) => this.handleEphemeral(session, m),
        onError: (e) => this.fail(session, 'error', e.message),
      },
    );

    const gatewayStaticPubHex = Buffer.from(this.staticKeys.publicKey).toString('hex');
    const pskHex = Buffer.from(psk).toString('hex');
    const qrPayload = encodeQrPayload({
      v: 1,
      relayUrl: this.relayUrl,
      linkId,
      gatewayStaticPubHex,
      pskHex,
    });
    return {
      linkId,
      relayUrl: this.relayUrl,
      gatewayStaticPubHex,
      pskHex,
      qrPayload,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    };
  }

  getStatus(linkId: string): PairingStatus | null {
    const s = this.sessions.get(linkId);
    if (!s) return null;
    return {
      linkId: s.linkId,
      state: s.state,
      sas: s.keys?.sas ?? null,
      deviceLabel: s.label,
      error: s.error,
    };
  }

  /** Verify the provisioning tag (the relay can't forge it without psk) and store the phone keys. */
  private handleProvision(session: PairingSession, msg: PhoneProvision): void {
    if (session.state !== 'awaiting-phone' || !session.psk || !this.staticKeys) {
      this.fail(session, 'error', 'provision in wrong state');
      return;
    }
    const expected = pairingProvisionTag({
      psk: session.psk,
      linkId: session.linkId,
      gwStaticPub: this.staticKeys.publicKey,
      phoneStaticPub: msg.phonePub,
      phoneNonce: msg.phoneNonce,
    });
    if (!bytesEqual(expected, msg.tag)) {
      this.fail(session, 'error', 'provisioning tag mismatch');
      void this.transport.teardown();
      return;
    }
    session.phone = msg;
    // Advertise our ephemeral so the phone can derive the same keys.
    this.transport.sendEphemeral(session.gwEphemeral.publicKey, session.gwNonce);
  }

  /** Derive session keys (psk folded in) and surface the SAS for human confirmation. */
  private handleEphemeral(session: PairingSession, msg: EphemeralMessage): void {
    if (session.state !== 'awaiting-phone' || !session.phone || !session.psk || !this.staticKeys) {
      this.fail(session, 'error', 'ephemeral in wrong state');
      return;
    }
    session.keys = deriveGatewaySessionKeys({
      linkId: session.linkId,
      gwStaticPriv: this.staticKeys.privateKey,
      gwStaticPub: this.staticKeys.publicKey,
      gwEphemeralPriv: session.gwEphemeral.privateKey,
      gwEphemeralPub: session.gwEphemeral.publicKey,
      gwNonce: session.gwNonce,
      phoneStaticPub: session.phone.phonePub,
      phoneEphemeralPub: msg.ephemeralPub,
      phoneNonce: msg.connNonce,
      psk: session.psk,
    });
    // Send our key-confirmation (cfm_g) so the phone can verify before showing SAS.
    this.transport.sendKeyConfirm(session.keys.cfmG);
    session.state = 'awaiting-sas';
    this.logger.info('pairing: awaiting SAS confirmation', { linkId: session.linkId, sas: session.keys.sas });
  }

  /** SAS-confirmed by the desktop user: atomically commit the device and wipe the psk. */
  async confirm(linkId: string): Promise<{ ok: boolean; deviceId?: string; reason?: string }> {
    const session = this.sessions.get(linkId);
    if (!session) return { ok: false, reason: 'not found' };
    if (session.state !== 'awaiting-sas' || !session.phone || !session.keys) {
      return { ok: false, reason: 'not awaiting SAS confirmation' };
    }
    const deviceId = toBase64Url(new Uint8Array(randomBytes(12)));
    const device: AuthorizedDevice = {
      deviceId,
      publicKeyHex: Buffer.from(session.phone.phonePub).toString('hex'),
      slotSecretHashHex: Buffer.from(session.phone.slotSecretHash).toString('hex'),
      label: session.label,
      linkId: session.linkId,
      createdAt: new Date().toISOString(),
    };
    await addAuthorizedDevice(this.store, device);
    // Deliver the phone's slotSecretHash to the relay so the phone-slot auth can
    // later succeed: persist a per-link phone slot commitment the tunnel-client
    // re-registers on (re)connect. (The relay stores it verbatim on first phone
    // auth; we keep our copy for continuity checks.)
    await this.store.set(
      `relay:phone-slot-hash:${session.linkId}`,
      Buffer.from(session.phone.slotSecretHash).toString('hex'),
    );
    // Confirm to the phone, then wipe psk and ephemerals from the live session.
    this.transport.sendKeyConfirm(session.keys.cfmG);
    session.psk = null;
    session.deviceId = deviceId;
    session.state = 'committed';
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    this.logger.info('pairing: committed device', { linkId, deviceId });
    return { ok: true, deviceId };
  }

  /** Operator-rejected or out-of-band failure: tear down the relay link and wipe psk. */
  async reject(linkId: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(linkId);
    if (!session) return { ok: false };
    this.fail(session, 'rejected');
    await this.transport.teardown();
    return { ok: true };
  }

  private fail(session: PairingSession, state: PairingState, error?: string): void {
    session.state = state;
    session.psk = null;
    session.error = error ?? null;
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = null;
    }
  }
}
```

> Notes: `confirm` is the ONLY path that writes `relay:authorized-devices`. The psk is wiped on every terminal path (`fail` + `confirm`). The phone slotSecretHash is persisted under `relay:phone-slot-hash:<linkId>` so the relay's phone-slot auth can succeed on the phone's first/repeat connect — the relay stores the commitment verbatim, and the gateway keeps a copy for continuity.

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-server.test.ts
```
Expected: PASS — `6 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/pairing-server.ts apps/gateway/src/pairing-server.test.ts && git commit -m "feat(gateway): PairingManager state machine with atomic SAS-gated commit"
```

---

## Task 12: Real relay-backed PairingTransport (`createRelayPairingTransport`)

**Files:** Modify `apps/gateway/src/pairing-server.ts`, Modify `apps/gateway/src/pairing-server.test.ts`

The production transport dials the relay as `role=gateway`, runs `runJoinHandshake` (slot-auth), then carries the E2E pairing handshake over `Opcode.HANDSHAKE` inner frames. It receives, in order, the phone's `PROVISION` (0x90), then a pairing-only `KEY_CONFIRM` (0x92) carrying the phone's 32-byte `slotSecretHash`, then the phone's `EPHEMERAL` (0x91); it sends our `EPHEMERAL` (0x91) and `KEY_CONFIRM` (0x92) frames. We unit-test the frame-decode routing with a fake socket; the live dial path is exercised by Unit D.

**Phone slotSecretHash delivery (design decision, applied here):** the frozen `ProvisionMessage` is `{ phonePub, phoneNonce, tag }` and `EphemeralMessage` is `{ ephemeralPub, connNonce }` — neither has a field for the phone's `slotSecretHash`, which the gateway needs to store in `relay:authorized-devices` so the relay's phone-slot auth can later verify commitment continuity. Rather than invent a new control message, the phone delivers its `slotSecretHash` during pairing as the FIRST `KEY_CONFIRM` (0x92) frame's `confirm` field. The transport treats the first inbound 0x92 in the pairing flow as the phone's `slotSecretHash` (NOT as `cfm_p`); the real key-confirmation exchange happens after the SAS step over the encrypted channel. `onPhoneProvisioned` fires exactly once, after BOTH the 0x90 PROVISION and the 0x92 slot-hash have arrived.

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/pairing-server.test.ts`:

```ts
import { type PhoneProvision, createRelayPairingTransport } from './pairing-server.js';
import {
  type EphemeralMessage,
  HandshakeMsgType,
  Opcode,
  decodeInnerFrame,
  encodeEphemeral,
  encodeInnerFrame,
  encodeKeyConfirm,
  encodeProvision,
  peekHandshakeMsgType,
  splitChunks,
} from '@dash/relay-protocol';
// (generateX25519KeyPair, randomBytes16, randomBytes32, slotSecretCommitment are
//  already imported by the Task 11 test block at the top of this file.)

describe('createRelayPairingTransport frame routing', () => {
  it('fires onPhoneProvisioned after PROVISION + slot-hash, then onPhoneEphemeral', async () => {
    const provisions: PhoneProvision[] = [];
    const ephemerals: EphemeralMessage[] = [];
    let inbound: ((b: Uint8Array) => void) | null = null;
    const sent: Uint8Array[] = [];

    const transport = createRelayPairingTransport({
      logger: noopLogger,
      // Inject a fake binary socket factory: no real network.
      dial: async () => ({
        send: (b: Uint8Array) => {
          sent.push(b);
        },
        onMessage: (h: (b: Uint8Array) => void) => {
          inbound = h;
        },
        close: () => {},
      }),
      // Skip slot-auth in the test by stubbing the join step.
      runJoin: async () => {},
    });

    await transport.connect(
      { linkId: 'L'.repeat(32), relayUrl: 'wss://relay.example', gwSlotSecret: new Uint8Array(32) },
      {
        onPhoneProvisioned: (m) => provisions.push(m),
        onPhoneEphemeral: (m) => ephemerals.push(m),
        onError: () => {},
      },
    );

    // Phone -> PROVISION frame (does not fire onPhoneProvisioned alone).
    const sp = generateX25519KeyPair();
    const phoneNonce = randomBytes16();
    const provFrame = splitChunks(
      Opcode.HANDSHAKE,
      0,
      encodeProvision({ phonePub: sp.publicKey, phoneNonce, tag: new Uint8Array(32) }),
    )[0];
    inbound?.(encodeInnerFrame(provFrame));
    expect(provisions.length).toBe(0);

    // Phone -> KEY_CONFIRM carrying its 32-byte slotSecretHash (pairing-only).
    const slotHash = slotSecretCommitment(randomBytes32());
    const slotHashFrame = splitChunks(
      Opcode.HANDSHAKE,
      0,
      encodeKeyConfirm({ confirm: slotHash }),
    )[0];
    inbound?.(encodeInnerFrame(slotHashFrame));
    expect(provisions.length).toBe(1);
    expect(Buffer.from(provisions[0].slotSecretHash).toString('hex')).toBe(
      Buffer.from(slotHash).toString('hex'),
    );

    // Phone -> EPHEMERAL frame.
    const ep = generateX25519KeyPair();
    const ephFrame = splitChunks(
      Opcode.HANDSHAKE,
      0,
      encodeEphemeral({ ephemeralPub: ep.publicKey, connNonce: phoneNonce }),
    )[0];
    inbound?.(encodeInnerFrame(ephFrame));
    expect(ephemerals.length).toBe(1);
  });

  it('sendEphemeral emits a HANDSHAKE/EPHEMERAL inner frame', async () => {
    const sent: Uint8Array[] = [];
    const transport = createRelayPairingTransport({
      logger: noopLogger,
      dial: async () => ({
        send: (b: Uint8Array) => {
          sent.push(b);
        },
        onMessage: () => {},
        close: () => {},
      }),
      runJoin: async () => {},
    });
    await transport.connect(
      { linkId: 'L'.repeat(32), relayUrl: 'wss://relay.example', gwSlotSecret: new Uint8Array(32) },
      { onPhoneProvisioned: () => {}, onPhoneEphemeral: () => {}, onError: () => {} },
    );
    transport.sendEphemeral(new Uint8Array(32).fill(9), randomBytes16());
    const frame = decodeInnerFrame(sent[sent.length - 1]);
    expect(frame.type).toBe(Opcode.HANDSHAKE);
    expect(peekHandshakeMsgType(frame.payload)).toBe(HandshakeMsgType.EPHEMERAL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-server.test.ts
```
Expected: FAIL — `createRelayPairingTransport` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/gateway/src/pairing-server.ts`. Extend the `@dash/relay-protocol` import (one consolidated statement) to add the frame/handshake symbols, and import the join helper from tunnel-client and `ws`:

```ts
import {
  ChunkReassembler,
  HandshakeMsgType,
  type InnerFrame,
  Opcode,
  Role as RoleEnum,
  decodeEphemeral,
  decodeInnerFrame,
  decodeKeyConfirm,
  decodeProvision,
  encodeEphemeral,
  encodeInnerFrame,
  encodeKeyConfirm,
  peekHandshakeMsgType,
  splitChunks,
} from '@dash/relay-protocol';
import { WebSocket } from 'ws';
import { type JoinSocket, runJoinHandshake } from './tunnel-client.js';
```

Then add the transport factory. The pairing flow over `Opcode.HANDSHAKE` inner frames is: inbound from the phone come `PROVISION` (0x90), then a pairing-only `KEY_CONFIRM` (0x92) carrying the phone's 32-byte `slotSecretHash`, then `EPHEMERAL` (0x91); `onPhoneProvisioned` fires once both the 0x90 and the 0x92 slot-hash have arrived. Outbound we send our `EPHEMERAL` (0x91) and `KEY_CONFIRM` (0x92).

```ts
/** Binary socket surface the relay transport drives (mirrors JoinSocket). */
type BinarySocket = JoinSocket;

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Production PairingTransport: dials the relay as role=gateway, runs slot-auth,
 * then carries the E2E pairing handshake over Opcode.HANDSHAKE inner frames.
 * `dial` and `runJoin` are injectable so the routing logic is unit-testable.
 */
export function createRelayPairingTransport(deps?: {
  logger: Logger;
  dial?: (url: string) => Promise<BinarySocket>;
  runJoin?: (socket: JoinSocket, linkId: string, gwSlotSecret: Uint8Array) => Promise<void>;
}): PairingTransport {
  const logger = deps?.logger ?? NOOP_LOGGER;
  const dial =
    deps?.dial ??
    ((url: string) =>
      new Promise<BinarySocket>((resolve, reject) => {
        const ws = new WebSocket(url, { maxPayload: 33_554_432 });
        ws.once('open', () =>
          resolve({
            send: (b) => ws.send(b),
            onMessage: (h) => ws.on('message', (d: Buffer) => h(new Uint8Array(d))),
            close: () => ws.close(),
          }),
        );
        ws.once('error', (err: Error) => reject(err));
      }));
  const runJoin =
    deps?.runJoin ??
    (async (socket: JoinSocket, linkId: string, gwSlotSecret: Uint8Array) => {
      await runJoinHandshake({
        socket,
        role: RoleEnum.GATEWAY,
        linkId,
        slotSecret: gwSlotSecret,
        logger,
      });
    });

  let socket: BinarySocket | null = null;
  const reassembler = new ChunkReassembler();

  const sendHandshake = (payload: Uint8Array): void => {
    if (!socket) throw new Error('pairing transport not connected');
    for (const f of splitChunks(Opcode.HANDSHAKE, 0, payload)) {
      socket.send(encodeInnerFrame(f));
    }
  };

  return {
    async connect(args, events) {
      const url = `${args.relayUrl.replace(/\/+$/, '')}/connect?linkId=${encodeURIComponent(
        args.linkId,
      )}&role=gateway`;
      socket = await dial(url);
      await runJoin(socket, args.linkId, args.gwSlotSecret);

      // Pairing sub-state: the phone's slotSecretHash arrives as the FIRST 0x92
      // KEY_CONFIRM (pairing-only); onPhoneProvisioned fires once both the 0x90
      // PROVISION and that slot-hash have arrived.
      let pendingProvision: {
        phonePub: Uint8Array;
        phoneNonce: Uint8Array;
        tag: Uint8Array;
      } | null = null;
      let phoneSlotHash: Uint8Array | null = null;

      socket.onMessage((bytes) => {
        let inner: InnerFrame;
        try {
          inner = decodeInnerFrame(bytes);
        } catch (err) {
          events.onError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (inner.type !== Opcode.HANDSHAKE) return;
        let assembled: Uint8Array | null;
        try {
          assembled = reassembler.push(inner);
        } catch (err) {
          events.onError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (!assembled) return;
        try {
          const kind = peekHandshakeMsgType(assembled);
          if (kind === HandshakeMsgType.PROVISION) {
            const prov = decodeProvision(assembled);
            pendingProvision = {
              phonePub: prov.phonePub,
              phoneNonce: prov.phoneNonce,
              tag: prov.tag,
            };
          } else if (kind === HandshakeMsgType.KEY_CONFIRM && phoneSlotHash === null) {
            // First 0x92 in the pairing flow = the phone's slotSecretHash (32 bytes).
            phoneSlotHash = decodeKeyConfirm(assembled).confirm;
          } else if (kind === HandshakeMsgType.EPHEMERAL) {
            events.onPhoneEphemeral(decodeEphemeral(assembled));
          }
          if (pendingProvision && phoneSlotHash) {
            events.onPhoneProvisioned({
              phonePub: pendingProvision.phonePub,
              phoneNonce: pendingProvision.phoneNonce,
              tag: pendingProvision.tag,
              slotSecretHash: phoneSlotHash,
            });
            pendingProvision = null; // fire exactly once
          }
        } catch (err) {
          events.onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    sendEphemeral(ephemeralPub, gwNonce) {
      sendHandshake(encodeEphemeral({ ephemeralPub, connNonce: gwNonce }));
    },
    sendKeyConfirm(confirm) {
      sendHandshake(encodeKeyConfirm({ confirm }));
    },
    async teardown() {
      if (socket) {
        socket.close();
        socket = null;
      }
    },
  };
}
```

> Notes:
> 1. NO `any` — `EphemeralMessage`/`PhoneProvision` are the typed event payloads; `decode*` helpers return typed structs.
> 2. NO placeholder bodies — the message handler is complete; `onPhoneProvisioned` fires exactly once.
> 3. Every symbol is imported from `@dash/relay-protocol` by exact name (never `@relay-protocol`).

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-server.test.ts
```
Expected: PASS — `8 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/pairing-server.ts apps/gateway/src/pairing-server.test.ts && git commit -m "feat(gateway): relay-backed PairingTransport for the gateway pairing handshake"
```

---

## Task 13: Pairing HTTP routes (`mountPairingRoutes`)

**Files:** Create `apps/gateway/src/pairing-routes.ts`, Create `apps/gateway/src/pairing-routes.test.ts`

These are the frozen routes the CLI (Unit D) drives. They wrap a `PairingManager` injected by the caller. The routes are mounted onto the existing management Hono app (Task 14), so they inherit the bearer auth + logging middleware already declared in `management-api.ts:123-247`.

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/pairing-routes.test.ts`:

```ts
import { Hono } from 'hono';
import type { PairingLinkInfo, PairingManager, PairingStatus } from './pairing-server.js';
import { mountPairingRoutes } from './pairing-routes.js';

/** A scripted PairingManager double. */
function fakeManager(overrides: Partial<PairingManager>): PairingManager {
  return {
    createLink: async (): Promise<PairingLinkInfo> => ({
      linkId: 'L'.repeat(32),
      relayUrl: 'wss://relay.example',
      gatewayStaticPubHex: 'ab'.repeat(32),
      pskHex: 'cd'.repeat(32),
      qrPayload: 'QR',
      expiresAt: '2026-06-17T10:01:15.000Z',
    }),
    getStatus: (): PairingStatus | null => ({
      linkId: 'L'.repeat(32),
      state: 'awaiting-sas',
      sas: '123456',
      deviceLabel: 'My Phone',
      error: null,
    }),
    confirm: async () => ({ ok: true, deviceId: 'dev-1' }),
    reject: async () => ({ ok: true }),
    ...overrides,
  } as unknown as PairingManager;
}

function appWith(mgr: PairingManager): Hono {
  const app = new Hono();
  mountPairingRoutes(app, { manager: mgr });
  return app;
}

describe('pairing routes', () => {
  it('POST /pairing/links returns 201 with the link info', async () => {
    const res = await appWith(fakeManager({})).request('/pairing/links', {
      method: 'POST',
      body: JSON.stringify({ label: 'My Phone' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.linkId).toBe('L'.repeat(32));
    expect(body.qrPayload).toBe('QR');
  });

  it('GET /pairing/links/:linkId returns the status', async () => {
    const res = await appWith(fakeManager({})).request(`/pairing/links/${'L'.repeat(32)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).sas).toBe('123456');
  });

  it('GET unknown link returns 404', async () => {
    const mgr = fakeManager({ getStatus: () => null });
    const res = await appWith(mgr).request('/pairing/links/unknown');
    expect(res.status).toBe(404);
  });

  it('POST confirm returns 200 with deviceId', async () => {
    const res = await appWith(fakeManager({})).request(`/pairing/links/${'L'.repeat(32)}/confirm`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deviceId).toBe('dev-1');
  });

  it('POST confirm in the wrong state returns 409', async () => {
    const mgr = fakeManager({
      confirm: async () => ({ ok: false, reason: 'not awaiting SAS confirmation' }),
    });
    const res = await appWith(mgr).request(`/pairing/links/${'L'.repeat(32)}/confirm`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });

  it('POST reject returns 200', async () => {
    const res = await appWith(fakeManager({})).request(`/pairing/links/${'L'.repeat(32)}/reject`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-routes.test.ts
```
Expected: FAIL — `./pairing-routes.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/gateway/src/pairing-routes.ts`:

```ts
import type { Hono } from 'hono';
import type { PairingManager } from './pairing-server.js';

export interface PairingRoutesDeps {
  manager: PairingManager;
}

/**
 * Mount the gateway pairing routes onto an existing Hono app. The host app's
 * bearer middleware (management-api.ts) already protects these — they are not
 * re-authed here. The CLI (mc-cli pair) drives pairing exclusively through them.
 */
export function mountPairingRoutes(app: Hono, deps: PairingRoutesDeps): void {
  const { manager } = deps;

  app.post('/pairing/links', async (c) => {
    let label = 'Phone';
    try {
      const body = (await c.req.json()) as { label?: string };
      if (typeof body.label === 'string' && body.label.length > 0) label = body.label;
    } catch {
      // empty/invalid body -> default label
    }
    const link = await manager.createLink(label);
    return c.json(link, 201);
  });

  app.get('/pairing/links/:linkId', (c) => {
    const status = manager.getStatus(c.req.param('linkId'));
    if (!status) return c.json({ error: 'link not found' }, 404);
    return c.json(status);
  });

  app.post('/pairing/links/:linkId/confirm', async (c) => {
    const linkId = c.req.param('linkId');
    if (!manager.getStatus(linkId)) return c.json({ error: 'link not found' }, 404);
    const result = await manager.confirm(linkId);
    if (!result.ok) {
      return c.json({ error: result.reason ?? 'not awaiting SAS confirmation' }, 409);
    }
    return c.json({ ok: true, deviceId: result.deviceId });
  });

  app.post('/pairing/links/:linkId/reject', async (c) => {
    const linkId = c.req.param('linkId');
    if (!manager.getStatus(linkId)) return c.json({ error: 'link not found' }, 404);
    await manager.reject(linkId);
    return c.json({ ok: true });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/pairing-routes.test.ts
```
Expected: PASS — `6 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/pairing-routes.ts apps/gateway/src/pairing-routes.test.ts && git commit -m "feat(gateway): pairing HTTP routes over PairingManager"
```

---

## Task 14: Config — `--relay-url` flag + relay config

**Files:** Modify `apps/gateway/src/config.ts`, Create `apps/gateway/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/config.test.ts`:

```ts
import { DEFAULT_RELAY_URL, parseFlags, resolveRelayUrl } from './config.js';

describe('parseFlags --relay-url', () => {
  it('parses --relay-url', () => {
    const flags = parseFlags(['--relay-url', 'wss://relay.custom']);
    expect(flags.relayUrl).toBe('wss://relay.custom');
  });

  it('leaves relayUrl undefined when not passed', () => {
    expect(parseFlags([]).relayUrl).toBeUndefined();
  });
});

describe('resolveRelayUrl precedence', () => {
  it('prefers env over flag over config over default', () => {
    expect(resolveRelayUrl({ env: 'wss://e', flag: 'wss://f', config: 'wss://c' })).toBe('wss://e');
    expect(resolveRelayUrl({ flag: 'wss://f', config: 'wss://c' })).toBe('wss://f');
    expect(resolveRelayUrl({ config: 'wss://c' })).toBe('wss://c');
    expect(resolveRelayUrl({})).toBe(DEFAULT_RELAY_URL);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/config.test.ts
```
Expected: FAIL — `relayUrl`, `DEFAULT_RELAY_URL`, `resolveRelayUrl` do not exist.

- [ ] **Step 3: Write minimal implementation**

Edit `apps/gateway/src/config.ts`. Add `relayUrl` to the options interface and a flag arm, plus the default + resolver:

```ts
export interface LoadConfigOptions {
  managementPort?: number;
  channelPort?: number;
  token?: string;
  chatToken?: string;
  dataDir?: string;
  verbose?: boolean;
  relayUrl?: string;
}

/** Baked-in default relay endpoint; overridable via DASH_RELAY_URL > config > flag. */
export const DEFAULT_RELAY_URL = 'wss://relay.dash.build';

export function parseFlags(argv: string[]): LoadConfigOptions {
  const options: LoadConfigOptions = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--management-port' && argv[i + 1]) {
      options.managementPort = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--token' && argv[i + 1]) {
      options.token = argv[i + 1];
      i++;
    } else if (argv[i] === '--data-dir' && argv[i + 1]) {
      options.dataDir = argv[i + 1];
      i++;
    } else if (argv[i] === '--channel-port' && argv[i + 1]) {
      options.channelPort = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--chat-token' && argv[i + 1]) {
      options.chatToken = argv[i + 1];
      i++;
    } else if (argv[i] === '--relay-url' && argv[i + 1]) {
      options.relayUrl = argv[i + 1];
      i++;
    } else if (argv[i] === '--verbose') {
      options.verbose = true;
    }
  }

  return options;
}

/** Resolve the relay URL: DASH_RELAY_URL env > --relay-url flag > config relay.url > default. */
export function resolveRelayUrl(sources: {
  env?: string;
  flag?: string;
  config?: string;
}): string {
  return sources.env ?? sources.flag ?? sources.config ?? DEFAULT_RELAY_URL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway/src/config.test.ts
```
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/config.ts apps/gateway/src/config.test.ts && git commit -m "feat(gateway): --relay-url flag and relay URL precedence resolver"
```

---

## Task 15: Wire pairing routes + tunnel-client into gateway startup and shutdown

**Files:** Modify `apps/gateway/src/index.ts`

`index.ts` has no per-function tests (it is the composition root). The verification is a successful build + the full suite staying green. We mount the pairing routes on the management app before `serve()`, init the tunnel-client after `registry.load()` (line 121) and before the channel server binds (lines 337-360), and stop it FIRST in the shutdown handler (line 366) before `mcpManager.stop()` and `eventLogStore.close()`.

- [ ] **Step 1: Add the imports**

At the top of `apps/gateway/src/index.ts`, add to the local-import block (after the existing `import { parseFlags } from './config.js';` line, line 26):

```ts
import { DEFAULT_RELAY_URL, resolveRelayUrl } from './config.js';
import { mountPairingRoutes } from './pairing-routes.js';
import { PairingManager, createRelayPairingTransport } from './pairing-server.js';
import { initTunnelClient } from './tunnel-client.js';
```

> `parseFlags` is already imported from `./config.js` on line 26; merge `DEFAULT_RELAY_URL, resolveRelayUrl` into that existing import rather than adding a duplicate line: `import { DEFAULT_RELAY_URL, parseFlags, resolveRelayUrl } from './config.js';`

- [ ] **Step 2: Resolve the relay URL and build the PairingManager**

Immediately after the management app is created (`createGatewayManagementApp({...})`, which ends at line 314) and BEFORE the `createNodeWebSocket`/`mountProjectsWs` block (line 321), insert:

```ts
  // --- Relay transport (tunnel-client + pairing server) ---
  const relayUrl = resolveRelayUrl({
    env: process.env.DASH_RELAY_URL,
    flag: flags.relayUrl,
    config: undefined, // config.relay.url wiring lands when relay config is added to dash.json
  });
  const pairingManager = new PairingManager({
    store: credentialStore,
    transport: createRelayPairingTransport({ logger }),
    relayUrl,
    logger,
  });
  mountPairingRoutes(managementApp, { manager: pairingManager });
```

> `DEFAULT_RELAY_URL` is imported so the build has a referenced symbol even though `resolveRelayUrl` supplies it; if Biome flags it as unused, drop it from the import and rely on `resolveRelayUrl`'s internal default. (Keep `resolveRelayUrl`.)

- [ ] **Step 3: Initialize the tunnel-client after registry.load() and start it after the servers bind**

After `await registry.load();` (line 121) the static-key/handle creation can happen, but the handle's `start()` must run after the loopback servers (`:9200` chat, `:9300` management) are listening. So: declare the handle just after the management app + pairing manager are set up (Step 2 block), and call `.start()` right after `injectWebSocket(channelServer);` (line 360). Insert at the end of the Step 2 block:

```ts
  const tunnelClient = await initTunnelClient({
    relayUrl,
    chatToken: flags.chatToken ?? '',
    managementToken: flags.token ?? '',
    dataDir,
    logger,
    credentialStore,
    eventLogStore,
  });
```

Then, immediately after `injectWebSocket(channelServer);` (line 360) and before the three `console.log` lines (362-364), insert:

```ts
  await tunnelClient.start();
  console.log(`Gateway tunnel-client dialing relay at ${relayUrl}`);
```

- [ ] **Step 4: Stop the tunnel-client first on shutdown**

In the `shutdown` handler (line 366), make the FIRST awaited stop the tunnel-client, before `mcpManager.stop()`. Change the body so it reads:

```ts
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await tunnelClient.stop();
    await mcpManager.stop();
    await agents.stop();
    await gateway.stop();
    managementServer.close();
    channelServer.close();
    // Close the event-log DB last so any in-flight appends from the
    // agents/gateway shutdown path land cleanly. WAL checkpoints are
    // flushed on close, so the next gateway start sees a consistent
    // database.
    eventLogStore.close();
    projectsDb.db.close();
    process.exit(0);
  };
```

- [ ] **Step 5: Build, run the full gateway suite, lint, and commit**

Run (build first so `@dash/relay-protocol` dist + gateway typecheck are current):
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm run build --workspace @dash/relay-protocol && npm run build --workspace @dash/gateway
```
Expected: both builds succeed with no TypeScript errors.

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test -- apps/gateway && npm run lint
```
Expected: PASS — all gateway tests green; Biome reports no errors (no `any`, imports organized, 100-col).

Commit:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src/index.ts && git commit -m "feat(gateway): wire tunnel-client + pairing routes into startup/shutdown"
```

---

## Task 16: Full-suite green + final verification

**Files:** none (verification only)

- [ ] **Step 1: Build everything**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm run build
```
Expected: all packages and apps build (tsup) with no errors.

- [ ] **Step 2: Run the entire test suite**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm test
```
Expected: PASS — the full Vitest suite is green, including the new `apps/gateway/src/{tunnel-client,pairing-server,pairing-routes,config,deps}.test.ts` files.

- [ ] **Step 3: Lint**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && npm run lint
```
Expected: Biome check passes with no errors. If it reports formatting nits, run `npm run lint:fix`, re-run `npm test`, and amend the relevant commit.

- [ ] **Step 4: Confirm no forbidden tokens slipped in**

Run:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && grep -rnE "@relay-protocol|Co-Authored-By|: any\b|<<|TODO|TBD" apps/gateway/src/tunnel-client.ts apps/gateway/src/pairing-server.ts apps/gateway/src/pairing-routes.ts apps/gateway/src/config.ts || echo "clean"
```
Expected: prints `clean` (no matches). If any line matches, fix it before considering the unit done.

- [ ] **Step 5: Final commit (only if Step 3/4 required fixes)**

If lint:fix or a token fix changed files:
```
cd /Users/gerry/syncthing/cloud-g-work/Projects/dash && git add apps/gateway/src && git commit -m "chore(gateway): lint and final cleanup for tunnel-client + pairing server"
```
Otherwise this task is verification-only and produces no commit.

---

## Done criteria

- `apps/gateway/src/tunnel-client.ts` exports `initTunnelClient` returning `{ start, stop, stats }`, plus the building blocks (`getOrCreateStaticKeys`, `gatewaySlotSecretKey`, authorized-device helpers, `RelayDialer`, `runJoinHandshake`, `deriveGatewaySessionKeys`, `createChatBridge`, `createManagementBridge`, `dispatchInboundFrame`, `replayMissedChatEvents`), all typed (no `any`), importing only from `@dash/relay-protocol` by exact name.
- Reconnect works end to end: the pairing server persists the gateway slot secret under `gatewaySlotSecretKey(linkId)`, the session handshake sends and verifies key-confirmation on every connection, and a `CHAT_ANSWER` resume frame replays missed events via `eventLogStore.readSince` preserving `seq`.
- The pairing server (`pairing-server.ts` + `pairing-routes.ts`) creates a link, surfaces the QR payload, runs the gateway side of the provision/ephemeral/key-confirmation handshake, derives + exposes the SAS, and atomically commits `phoneStaticPub` + `slotSecretHash` to `relay:authorized-devices` on SAS confirm while wiping the psk — exposed over the four frozen `/pairing/*` routes the CLI depends on.
- `config.ts` resolves the relay URL (env > flag > config > default); `index.ts` mounts the routes and starts/stops the tunnel-client in the right order.
- `npm run build`, `npm test`, and `npm run lint` are all green.
