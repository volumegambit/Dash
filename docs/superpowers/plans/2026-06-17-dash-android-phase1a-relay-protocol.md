# Dash Android Phase 1A — relay-protocol (Wire Contract) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build `packages/relay-protocol`, the single frozen TypeScript wire contract — data plane (AEAD frame codec + crypto spine) **and** control plane (relay-join signaling + E2E handshake messages) — that the relay (Unit B), gateway tunnel-client (Unit C), and CLI harness (Unit D) all import so no unit ever reinvents the wire format.

**Architecture:** A dependency-free TS package compiled with tsup. It exposes (1) byte/encoding helpers, (2) hand-rolled crypto over Node 22 built-ins (X25519, HKDF-SHA256, HMAC-SHA256, SHA-256, IETF ChaCha20-Poly1305, counter nonce, CSPRNG), (3) the two-layer frame codec (outer AEAD record with direction-bound AAD + monotonic `recordSeq`, 16-byte big-endian inner header, chunk split/reassembly), (4) the handshake key-derivation (canonical IKM order, transcript salt, PRK with/without `psk`, directional + confirmation keys, 6-digit SAS), (5) **the canonical control-plane message types** — relay-join/role, the DO's 16-byte challenge, the slot-auth response `HMAC(slotSecret, challenge)` plus commitment `sha256(slotSecret)`, the provisioning message + tag, the ephemeral-exchange, and the key-confirmation — each as a typed struct with a tagged, canonically-encoded `encode*`/`decode*` helper, and (6) a checked-in cross-runtime crypto test vector that the Kotlin client (Phase 2) must reproduce byte-for-byte.

**Tech Stack:** Node.js 22 (ESM only), TypeScript strict (ES2024 target, NodeNext resolution), tsup build, Vitest (globals — never import `describe`/`it`/`expect`), Biome (2-space, single quotes, semicolons, 100-col; no `any`). All crypto is Node `node:crypto` built-ins — zero runtime dependencies.

---

## Context the reader needs (read this before starting)

You are building **one package only**: `packages/relay-protocol`. It has **no source dependencies on any other package** and adds **no runtime dependencies**. Everything is Node built-ins.

**Why this package is the contract.** A previous attempt froze only the data plane (frame codec + crypto) and left the control plane unspecified. As a result the relay, gateway, and CLI each invented incompatible relay-join and handshake wire formats, and the gateway pairing server was never written. **This plan fixes that** by defining the control plane as concrete typed messages with `encode*`/`decode*` helpers right here, so Units B/C/D import them verbatim.

**The two planes:**

- **Data plane** (post-handshake bulk traffic): every WebSocket binary message is one outer AEAD record `[10-byte header][ciphertext][16-byte tag]`. The 10-byte header is the AAD (authenticated, not encrypted): `protoVer(1) ‖ direction(1) ‖ recordSeq(8 BE)`. The plaintext is one inner frame: `[16-byte BE inner header][payload]`. The inner header is `ver(1) ‖ type(1, opcode) ‖ flags(1) ‖ reserved(1)=0 ‖ streamId(4 BE) ‖ chunkIndex(4 BE) ‖ payloadLen(4 BE)`.

- **Control plane** (the relay-join handshake + the E2E pairing/session handshake). Two sub-families:
  - **Relay-join signaling** (client ↔ relay DO, *plaintext over the WS, JSON-friendly but encoded as canonical tagged binary so TS and Kotlin agree byte-for-byte*): `JOIN` (role = gateway|phone, linkId), the DO's `CHALLENGE` (16 random bytes), the client's `SLOT_AUTH` response (`slotProof = HMAC(slotSecret, challenge)`, plus commitment `slotSecretHash = sha256(slotSecret)`), and the DO's `JOIN_RESULT` (ok / error code). The relay never sees `slotSecret` in cleartext and re-challenges on every (re)connect, so a captured URL is not replayable.
  - **E2E handshake messages** carried inside opcode `0x04 HANDSHAKE` data-plane frames (these specific frames are *not* AEAD-sealed; their integrity comes from the HMAC/key-confirmation construction): `PROVISION` (phonePub, phoneNonce, `tag = HMAC(psk, …)`), `EPHEMERAL` (ephemeral pubkey + per-connection 16-byte nonce, sent by each side), and `KEY_CONFIRM` (`cfm_g` or `cfm_p`). The 6-digit SAS is derived from the PRK; both sides display it.

**Canonical encoding rule (control plane).** Every control-plane message is `[1-byte msgType][fields…]`, big-endian, fixed field order. Variable-length fields that are not fixed-size (only `linkId`, which is ASCII) are length-prefixed with a 2-byte BE length. Fixed-size crypto fields (32-byte pubkeys, 16-byte nonces/challenges, 32-byte tags/hashes) are written raw at their documented offsets. This makes the format trivially mirrored by Kotlin `ByteBuffer`. **Decoders validate every length and reject trailing bytes** — a decoder that silently ignores extra bytes is a bug.

**Repo conventions you MUST follow:**
- ESM only. Local imports use `.js` extensions (e.g. `import { concatBytes } from './bytes.js';`) even though the source file is `.ts`.
- Vitest globals are enabled — **do NOT** `import { describe, it, expect } from 'vitest'`. Just use them.
- Biome strict: 2-space indent, single quotes, semicolons always, 100-col width. **No `any`.** Run `npm run lint:fix` if Biome reformats.
- Package scope is `@dash/relay-protocol` — **never** `@relay-protocol`.
- Commit messages **MUST NOT** contain a `Co-Authored-By` line (project CLAUDE.md forbids it). Stage only the exact files each task lists; never `git add -A`.
- Node built-ins verified present on this machine (Node v22.20.0): `generateKeyPairSync('x25519')`, `diffieHellman()`, `hkdfSync('sha256', …)`, `createCipheriv('chacha20-poly1305', …, {authTagLength:16})` (the IETF variant). `xchacha20-poly1305` is **absent** (`ERR_CRYPTO_UNKNOWN_CIPHER`) — do not use it. The existing gateway already uses the same `createCipheriv` idiom for AES-256-GCM in `apps/gateway/src/crypto.ts`, confirming the built-in path.

**Verified DER prefixes for raw X25519 keys (Node v22.20.0):**
- SPKI (public) export is 44 bytes; the 12-byte prefix is `302a300506032b656e032100`, followed by the 32 raw public bytes.
- PKCS8 (private) export is 48 bytes; the 16-byte prefix is `302e020100300506032b656e04220420`, followed by the 32 raw private bytes.
These constants are used to convert between raw 32-byte keys and Node `KeyObject`s.

**Test runner picks up the package automatically.** The root `vitest.config.ts` `include` is `packages/*/src/**/*.test.ts`, so any `packages/relay-protocol/src/**/*.test.ts` is run with `vitest run`. The package can also be targeted directly with `npx vitest run packages/relay-protocol`.

---

## File Structure

```
packages/relay-protocol/
├── package.json                     # @dash/relay-protocol, tsup build, no deps
├── tsconfig.json                    # extends ../../tsconfig.base.json
├── tsup.config.ts                   # single entry src/index.ts, esm, dts
├── scripts/
│   └── gen-vector.mts               # one-off generator that freezes the crypto vector (outside src/, not built)
└── src/
    ├── index.ts                     # public API barrel (THE frozen contract surface)
    ├── bytes.ts                     # concat, equality, base64url, utf8, BE uint32/uint64 read/write
    ├── bytes.test.ts
    ├── crypto.ts                    # X25519, HKDF, HMAC, SHA-256, IETF ChaCha20-Poly1305, counter nonce, CSPRNG
    ├── crypto.test.ts
    ├── frame.ts                     # constants, opcodes, inner codec, outer AEAD record, seq guard, chunking
    ├── frame.test.ts
    ├── handshake.ts                 # transcript, key derivation, SAS, provisioning tag, slot-auth proof
    ├── handshake.test.ts
    ├── control.ts                   # CONTROL PLANE: relay-join + E2E handshake message types + encode/decode
    ├── control.test.ts
    ├── vectors.ts                   # frozen CRYPTO_VECTOR (cross-runtime parity source of truth)
    ├── vectors.test.ts
    └── integration.test.ts          # full inner+outer round-trip with chunking + monotonicity
```

**Task map (each task = one TDD cycle):**

| Task | Module | What it adds |
|------|--------|--------------|
| 1 | scaffolding | package.json, tsconfig, tsup.config, empty index.ts; package builds |
| 2 | bytes.ts | concat, equality, base64url, utf8 |
| 3 | bytes.ts | BE uint32/uint64 read/write (lock the contract) |
| 4 | crypto.ts | X25519 keygen + raw↔KeyObject conversion |
| 5 | crypto.ts | X25519 diffie-hellman over raw keys |
| 6 | crypto.ts | HKDF-SHA256 extract/expand + HMAC + SHA-256 |
| 7 | crypto.ts | IETF ChaCha20-Poly1305 seal/open + counter nonce + CSPRNG |
| 8 | frame.ts | constants, opcodes, direction, flags |
| 9 | frame.ts | inner frame encode/decode |
| 10 | frame.ts | outer AEAD record seal/open (direction-bound AAD) |
| 11 | frame.ts | recordSeq monotonicity guard |
| 12 | frame.ts | chunk split |
| 13 | frame.ts | chunk reassembly (gap/dup/cap fatal) |
| 14 | handshake.ts | transcript builder |
| 15 | handshake.ts | SAS + provisioning tag |
| 16 | handshake.ts | session key derivation (psk-folded + psk-omitted) |
| 17 | handshake.ts | slot-auth proof + commitment helpers |
| 18 | control.ts | control-plane constants + relay-join messages (JOIN, CHALLENGE, SLOT_AUTH, JOIN_RESULT) |
| 19 | control.ts | E2E handshake messages (PROVISION, EPHEMERAL, KEY_CONFIRM) |
| 20 | index.ts | public API barrel (data + control plane) |
| 21 | vectors.ts | generate + freeze the cross-runtime crypto vector |
| 22 | vectors.test.ts | cross-runtime vector parity gate |
| 23 | integration.test.ts | end-to-end wire round-trip |
| 24 | — | full package green + lint + build (final gate) |

---

## Task 1: Scaffold the package

**Files:** Create `packages/relay-protocol/package.json`, Create `packages/relay-protocol/tsconfig.json`, Create `packages/relay-protocol/tsup.config.ts`, Create `packages/relay-protocol/src/index.ts`, Modify `package.json` (root workspaces + build script)

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/index.test.ts`:
```ts
import * as api from './index.js';

describe('package bootstrap', () => {
  it('exposes a module object (even if empty for now)', () => {
    expect(typeof api).toBe('object');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/index.test.ts
```
Expected: FAIL — `Failed to resolve import "./index.js"` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `packages/relay-protocol/package.json`:
```json
{
  "name": "@dash/relay-protocol",
  "version": "0.2.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch"
  }
}
```

Create `packages/relay-protocol/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `packages/relay-protocol/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  skipNodeModulesBundle: true,
});
```

Create `packages/relay-protocol/src/index.ts`:
```ts
// Public API barrel for @dash/relay-protocol.
// Exports are added module-by-module as tasks complete (Task 20 is the full barrel).
export {};
```

Modify the root `package.json`: add `"packages/relay-protocol"` to the `workspaces` array (place it after `"packages/projects"`), and add `-w packages/relay-protocol` to the root `build` script as the **first** workspace built (it has no internal deps, so build it before everything else). The build script's leading segment becomes:
```
npm run build -w packages/relay-protocol -w packages/models -w packages/projects -w packages/mcp ...
```
(keep the rest of the existing script unchanged).

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npm install
npx vitest run packages/relay-protocol/src/index.test.ts
```
Expected: PASS — the empty barrel resolves, the bootstrap test is green. (`npm install` re-links the new workspace.)

Then verify the package builds:
```
npm run build -w packages/relay-protocol
```
Expected: tsup writes `packages/relay-protocol/dist/index.js` and `dist/index.d.ts`, exit 0.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/package.json packages/relay-protocol/tsconfig.json packages/relay-protocol/tsup.config.ts packages/relay-protocol/src/index.ts packages/relay-protocol/src/index.test.ts package.json package-lock.json
git commit -m "feat(relay-protocol): scaffold package (tsup, tsconfig, empty barrel)"
```

---

## Task 2: Byte helpers — concat, equality, base64url, utf8

**Files:** Test `packages/relay-protocol/src/bytes.test.ts`, Create `packages/relay-protocol/src/bytes.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/bytes.test.ts`:
```ts
import {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from './bytes.js';

describe('concatBytes', () => {
  it('joins byte arrays in order', () => {
    const out = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5]));
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns empty for no args', () => {
    expect(concatBytes().length).toBe(0);
  });
});

describe('bytesEqual', () => {
  it('is true for equal contents', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('is false for different contents of equal length', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('is false (no throw) for length mismatch', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('base64url round-trip', () => {
  it('encodes and decodes without padding', () => {
    const bytes = new Uint8Array([255, 0, 128, 64, 32]);
    const s = toBase64Url(bytes);
    expect(s).not.toContain('=');
    expect(s).not.toContain('+');
    expect(s).not.toContain('/');
    expect([...fromBase64Url(s)]).toEqual([...bytes]);
  });
});

describe('utf8', () => {
  it('round-trips a unicode string', () => {
    const s = 'dash ✓ 日本語';
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/bytes.test.ts
```
Expected: FAIL — `Failed to resolve import "./bytes.js"` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `packages/relay-protocol/src/bytes.ts`:
```ts
import { timingSafeEqual } from 'node:crypto';

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function writeUint32BE(value: number): Uint8Array {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return new Uint8Array(buf);
}

export function readUint32BE(buf: Uint8Array, offset: number): number {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.length).readUInt32BE(offset);
}

export function writeUint16BE(value: number): Uint8Array {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16BE(value & 0xffff, 0);
  return new Uint8Array(buf);
}

export function readUint16BE(buf: Uint8Array, offset: number): number {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.length).readUInt16BE(offset);
}

export function writeUint64BE(value: bigint): Uint8Array {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64BE(value, 0);
  return new Uint8Array(buf);
}

export function readUint64BE(buf: Uint8Array, offset: number): bigint {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.length).readBigUInt64BE(offset);
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function utf8Encode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf-8'));
}

export function utf8Decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf-8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/bytes.test.ts
```
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/bytes.ts packages/relay-protocol/src/bytes.test.ts
git commit -m "feat(relay-protocol): byte and encoding helpers"
```

---

## Task 3: Big-endian integer reader/writer tests (uint16 + uint32 + uint64)

**Files:** Test `packages/relay-protocol/src/bytes.test.ts` (extend)

The writers/readers were implemented in Task 2 (they live in `bytes.ts`); this task adds dedicated tests so downstream frame/control code can rely on the BE contract.

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/bytes.test.ts`:
```ts
import {
  readUint16BE,
  readUint32BE,
  readUint64BE,
  writeUint16BE,
  writeUint32BE,
  writeUint64BE,
} from './bytes.js';

describe('uint16 BE', () => {
  it('writes 2 big-endian bytes', () => {
    expect([...writeUint16BE(0x0102)]).toEqual([1, 2]);
  });

  it('reads back at an offset', () => {
    const buf = new Uint8Array([0xff, 0x00, 0x20]);
    expect(readUint16BE(buf, 1)).toBe(0x20);
  });
});

describe('uint32 BE', () => {
  it('writes 4 big-endian bytes', () => {
    expect([...writeUint32BE(0x01020304)]).toEqual([1, 2, 3, 4]);
  });

  it('reads back at an offset', () => {
    const buf = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x01]);
    expect(readUint32BE(buf, 1)).toBe(1);
  });
});

describe('uint64 BE', () => {
  it('round-trips a large 64-bit value', () => {
    const v = 0x0102030405060708n;
    const bytes = writeUint64BE(v);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(readUint64BE(bytes, 0)).toBe(v);
  });

  it('round-trips the max recordSeq', () => {
    const v = 0xffffffffffffffffn;
    expect(readUint64BE(writeUint64BE(v), 0)).toBe(v);
  });
});
```
**NOTE:** Biome's `organizeImports` merges these new `import` lines into the existing top-of-file import from `./bytes.js`. Run `npm run lint:fix` before committing so the file has a single merged import block.

- [ ] **Step 2: Run test to verify it fails (then passes immediately)**

Run:
```
npx vitest run packages/relay-protocol/src/bytes.test.ts
```
Expected: PASS — the implementations already exist from Task 2. This task locks the BE contract with explicit assertions. If any assertion is RED, fix `bytes.ts` until green.

- [ ] **Step 3: Format and commit**
```
npm run lint:fix
git add packages/relay-protocol/src/bytes.test.ts
git commit -m "test(relay-protocol): lock big-endian integer contract"
```

---

## Task 4: X25519 keygen + raw↔KeyObject conversion

**Files:** Test `packages/relay-protocol/src/crypto.test.ts`, Create `packages/relay-protocol/src/crypto.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/crypto.test.ts`:
```ts
import {
  generateX25519KeyPair,
  privateKeyToRaw,
  publicKeyToRaw,
  rawToPrivateKey,
  rawToPublicKey,
} from './crypto.js';

describe('generateX25519KeyPair', () => {
  it('produces raw 32-byte public and private keys', () => {
    const kp = generateX25519KeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it('produces distinct keypairs each call', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    expect([...a.privateKey]).not.toEqual([...b.privateKey]);
  });
});

describe('raw key <-> KeyObject round-trip', () => {
  it('rebuilds a public KeyObject whose raw export matches', () => {
    const kp = generateX25519KeyPair();
    const obj = rawToPublicKey(kp.publicKey);
    expect([...publicKeyToRaw(obj)]).toEqual([...kp.publicKey]);
  });

  it('rebuilds a private KeyObject whose raw export matches', () => {
    const kp = generateX25519KeyPair();
    const obj = rawToPrivateKey(kp.privateKey);
    expect([...privateKeyToRaw(obj)]).toEqual([...kp.privateKey]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: FAIL — `Failed to resolve import "./crypto.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/relay-protocol/src/crypto.ts`:
```ts
import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';

export interface X25519KeyPairRaw {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

// DER prefixes for raw X25519 keys (verified on Node v22.20.0):
//   SPKI public export  = 44 bytes: 12-byte prefix + 32 raw public bytes.
//   PKCS8 private export = 48 bytes: 16-byte prefix + 32 raw private bytes.
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // 12 bytes
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex'); // 16 bytes

export function publicKeyToRaw(key: KeyObject): Uint8Array {
  const der = key.export({ type: 'spki', format: 'der' });
  return new Uint8Array(der.subarray(der.length - 32));
}

export function privateKeyToRaw(key: KeyObject): Uint8Array {
  const der = key.export({ type: 'pkcs8', format: 'der' });
  return new Uint8Array(der.subarray(der.length - 32));
}

export function rawToPublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

export function rawToPrivateKey(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function generateX25519KeyPair(): X25519KeyPairRaw {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKeyToRaw(publicKey),
    privateKey: privateKeyToRaw(privateKey),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/crypto.ts packages/relay-protocol/src/crypto.test.ts
git commit -m "feat(relay-protocol): X25519 keygen and raw-key conversion"
```

---

## Task 5: X25519 Diffie-Hellman over raw keys

**Files:** Test `packages/relay-protocol/src/crypto.test.ts` (extend), Modify `packages/relay-protocol/src/crypto.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/crypto.test.ts`:
```ts
import { diffieHellmanRaw } from './crypto.js';

describe('diffieHellmanRaw', () => {
  it('is symmetric: DH(aPriv,bPub) == DH(bPriv,aPub)', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    const ssA = diffieHellmanRaw(a.privateKey, b.publicKey);
    const ssB = diffieHellmanRaw(b.privateKey, a.publicKey);
    expect(ssA.length).toBe(32);
    expect([...ssA]).toEqual([...ssB]);
  });
});
```
(Biome will merge the new import with the existing `./crypto.js` import.)

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: FAIL — `diffieHellmanRaw is not a function` / no exported member `diffieHellmanRaw`.

- [ ] **Step 3: Write minimal implementation** — extend the `node:crypto` import line in `crypto.ts` to add `diffieHellman`:
```ts
import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';
```
Then append to `crypto.ts`:
```ts
export function diffieHellmanRaw(privateRaw: Uint8Array, peerPublicRaw: Uint8Array): Uint8Array {
  const shared = diffieHellman({
    privateKey: rawToPrivateKey(privateRaw),
    publicKey: rawToPublicKey(peerPublicRaw),
  });
  return new Uint8Array(shared);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/crypto.ts packages/relay-protocol/src/crypto.test.ts
git commit -m "feat(relay-protocol): X25519 diffie-hellman over raw keys"
```

---

## Task 6: HKDF-SHA256 Extract/Expand + HMAC + SHA-256

**Files:** Test `packages/relay-protocol/src/crypto.test.ts` (extend), Modify `packages/relay-protocol/src/crypto.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/crypto.test.ts`:
```ts
import { hkdfSync } from 'node:crypto';
import { hkdfExpand, hkdfExtract, hmacSha256, sha256 } from './crypto.js';

describe('hkdf extract+expand parity with node hkdfSync', () => {
  it('Extract then Expand equals node hkdfSync (single-call)', () => {
    const salt = new Uint8Array(32).fill(2);
    const ikm = new Uint8Array(32).fill(1);
    const info = new TextEncoder().encode('dash g2p key');
    const prk = hkdfExtract(salt, ikm);
    expect(prk.length).toBe(32);
    const okm = hkdfExpand(prk, info, 32);
    const reference = new Uint8Array(hkdfSync('sha256', ikm, salt, info, 32));
    expect([...okm]).toEqual([...reference]);
  });

  it('Expand can produce more than 32 bytes (multi-block)', () => {
    const prk = hkdfExtract(new Uint8Array(32), new Uint8Array(32).fill(9));
    expect(hkdfExpand(prk, new Uint8Array([1]), 64).length).toBe(64);
  });
});

describe('hmacSha256 and sha256', () => {
  it('hmacSha256 returns 32 bytes and is deterministic', () => {
    const key = new Uint8Array(32).fill(7);
    const data = new TextEncoder().encode('dash-sas');
    const a = hmacSha256(key, data);
    const b = hmacSha256(key, data);
    expect(a.length).toBe(32);
    expect([...a]).toEqual([...b]);
  });

  it('sha256 returns 32 bytes', () => {
    expect(sha256(new Uint8Array([1, 2, 3])).length).toBe(32);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: FAIL — no exported members `hkdfExtract`/`hkdfExpand`/`hmacSha256`/`sha256`.

- [ ] **Step 3: Write minimal implementation** — extend the `node:crypto` import in `crypto.ts` to add `createHash, createHmac`, and add the `./bytes.js` import. The import block at the top of `crypto.ts` becomes:
```ts
import {
  type KeyObject,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';
import { concatBytes } from './bytes.js';
```
Then append to `crypto.ts`:
```ts
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest());
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  // RFC 5869: PRK = HMAC-Hash(salt, IKM)
  return hmacSha256(salt, ikm);
}

export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  // RFC 5869: T(0)=empty; T(i)=HMAC(PRK, T(i-1) || info || i); OKM = first `length` bytes of T(1..)
  const out = new Uint8Array(length);
  let prev = new Uint8Array(0);
  let written = 0;
  let counter = 1;
  while (written < length) {
    const block = hmacSha256(prk, concatBytes(prev, info, new Uint8Array([counter])));
    const take = Math.min(block.length, length - written);
    out.set(block.subarray(0, take), written);
    written += take;
    prev = block;
    counter += 1;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: PASS — HKDF parity, multi-block expand, HMAC determinism, SHA-256 all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/crypto.ts packages/relay-protocol/src/crypto.test.ts
git commit -m "feat(relay-protocol): HKDF extract/expand, HMAC, SHA-256 over node builtins"
```

---

## Task 7: IETF ChaCha20-Poly1305 AEAD seal/open + counter nonce + CSPRNG

**Files:** Test `packages/relay-protocol/src/crypto.test.ts` (extend), Modify `packages/relay-protocol/src/crypto.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/crypto.test.ts`:
```ts
import { aeadOpen, aeadSeal, counterNonce, randomBytes16, randomBytes32 } from './crypto.js';

describe('aeadSeal / aeadOpen (IETF ChaCha20-Poly1305)', () => {
  const key = new Uint8Array(32).fill(7);
  const nonce = counterNonce(0n);
  const aad = new TextEncoder().encode('aad-bytes');
  const pt = new TextEncoder().encode('hello world');

  it('seals to ciphertext+16-byte-tag and opens back', () => {
    const sealed = aeadSeal(key, nonce, aad, pt);
    expect(sealed.length).toBe(pt.length + 16);
    const opened = aeadOpen(key, nonce, aad, sealed);
    expect([...opened]).toEqual([...pt]);
  });

  it('throws on a tampered tag', () => {
    const sealed = aeadSeal(key, nonce, aad, pt);
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => aeadOpen(key, nonce, aad, sealed)).toThrow();
  });

  it('throws on wrong aad (direction substitution)', () => {
    const sealed = aeadSeal(key, nonce, aad, pt);
    const wrongAad = new TextEncoder().encode('aad-other');
    expect(() => aeadOpen(key, nonce, wrongAad, sealed)).toThrow();
  });

  it('throws on a too-short sealed record', () => {
    expect(() => aeadOpen(key, nonce, aad, new Uint8Array(8))).toThrow(/sealed record too short/);
  });
});

describe('counterNonce', () => {
  it('is 12 bytes: 4 zero bytes then 8-byte BE counter', () => {
    const n = counterNonce(0x0102030405060708n);
    expect([...n]).toEqual([0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('random bytes', () => {
  it('randomBytes32 returns 32 bytes', () => {
    expect(randomBytes32().length).toBe(32);
  });
  it('randomBytes16 returns 16 bytes', () => {
    expect(randomBytes16().length).toBe(16);
  });
  it('randomBytes32 differs across calls', () => {
    expect([...randomBytes32()]).not.toEqual([...randomBytes32()]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: FAIL — no exported members `aeadSeal`/`aeadOpen`/`counterNonce`/`randomBytes32`/`randomBytes16`.

- [ ] **Step 3: Write minimal implementation** — extend the `node:crypto` import in `crypto.ts` to add `createCipheriv, createDecipheriv, randomBytes`. The import block becomes:
```ts
import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { concatBytes } from './bytes.js';
```
Then append to `crypto.ts`:
```ts
const AEAD_ALGO = 'chacha20-poly1305';
const AEAD_TAG_BYTES = 16;

export function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv(AEAD_ALGO, key, nonce, { authTagLength: AEAD_TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return concatBytes(new Uint8Array(ct), new Uint8Array(tag));
}

export function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
): Uint8Array {
  if (sealed.length < AEAD_TAG_BYTES) throw new Error('sealed record too short');
  const ct = sealed.subarray(0, sealed.length - AEAD_TAG_BYTES);
  const tag = sealed.subarray(sealed.length - AEAD_TAG_BYTES);
  const decipher = createDecipheriv(AEAD_ALGO, key, nonce, { authTagLength: AEAD_TAG_BYTES });
  decipher.setAAD(aad, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return new Uint8Array(pt);
}

export function counterNonce(recordSeq: bigint): Uint8Array {
  const nonce = new Uint8Array(12); // first 4 bytes are zero
  const counter = Buffer.allocUnsafe(8);
  counter.writeBigUInt64BE(recordSeq, 0);
  nonce.set(counter, 4);
  return nonce;
}

export function randomBytes32(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function randomBytes16(): Uint8Array {
  return new Uint8Array(randomBytes(16));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/crypto.test.ts
```
Expected: PASS — AEAD round-trip, tamper/aad rejection, short-record rejection, nonce layout, CSPRNG sizes all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/crypto.ts packages/relay-protocol/src/crypto.test.ts
git commit -m "feat(relay-protocol): IETF ChaCha20-Poly1305 AEAD, counter nonce, CSPRNG"
```

---

## Task 8: Frame constants — opcodes, sizes, direction, flags

**Files:** Test `packages/relay-protocol/src/frame.test.ts`, Create `packages/relay-protocol/src/frame.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/frame.test.ts`:
```ts
import {
  AEAD_NONCE_LEN,
  AEAD_TAG_LEN,
  Direction,
  FrameFlags,
  INNER_HEADER_LEN,
  INNER_VER,
  MAX_FRAME_PAYLOAD,
  MAX_REASSEMBLY,
  MAX_WS_MESSAGE,
  Opcode,
  OUTER_HEADER_LEN,
  PROTO_VER,
} from './frame.js';

describe('frame constants', () => {
  it('matches the spec sizes', () => {
    expect(PROTO_VER).toBe(1);
    expect(INNER_VER).toBe(1);
    expect(OUTER_HEADER_LEN).toBe(10);
    expect(INNER_HEADER_LEN).toBe(16);
    expect(AEAD_TAG_LEN).toBe(16);
    expect(AEAD_NONCE_LEN).toBe(12);
    expect(MAX_FRAME_PAYLOAD).toBe(1024 * 1024);
    expect(MAX_REASSEMBLY).toBe(32 * 1024 * 1024);
    expect(MAX_WS_MESSAGE).toBe(32 * 1024 * 1024);
  });

  it('directions are 0x01 gw->phone and 0x02 phone->gw', () => {
    expect(Direction.GW_TO_PHONE).toBe(0x01);
    expect(Direction.PHONE_TO_GW).toBe(0x02);
  });

  it('flags FINAL=bit0, CHUNKED=bit1', () => {
    expect(FrameFlags.FINAL).toBe(0b01);
    expect(FrameFlags.CHUNKED).toBe(0b10);
  });

  it('opcodes match the spec', () => {
    expect(Opcode.PING).toBe(0x00);
    expect(Opcode.PONG).toBe(0x01);
    expect(Opcode.CLOSE).toBe(0x02);
    expect(Opcode.ERROR_GLOBAL).toBe(0x03);
    expect(Opcode.HANDSHAKE).toBe(0x04);
    expect(Opcode.CHAT_START).toBe(0x10);
    expect(Opcode.CHAT_EVENT).toBe(0x11);
    expect(Opcode.CHAT_DONE).toBe(0x12);
    expect(Opcode.CHAT_ERROR).toBe(0x13);
    expect(Opcode.CHAT_CANCEL).toBe(0x14);
    expect(Opcode.CHAT_ANSWER).toBe(0x15);
    expect(Opcode.REQ).toBe(0x20);
    expect(Opcode.RESP).toBe(0x21);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: FAIL — `Failed to resolve import "./frame.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/relay-protocol/src/frame.ts`:
```ts
export const PROTO_VER = 1;
export const INNER_VER = 1;
export const OUTER_HEADER_LEN = 10;
export const INNER_HEADER_LEN = 16;
export const AEAD_TAG_LEN = 16;
export const AEAD_NONCE_LEN = 12;
export const MAX_FRAME_PAYLOAD = 1 * 1024 * 1024;
export const MAX_REASSEMBLY = 32 * 1024 * 1024;
export const MAX_WS_MESSAGE = 32 * 1024 * 1024;

export const Direction = {
  GW_TO_PHONE: 0x01,
  PHONE_TO_GW: 0x02,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export const FrameFlags = {
  FINAL: 0b0000_0001,
  CHUNKED: 0b0000_0010,
} as const;

export const Opcode = {
  PING: 0x00,
  PONG: 0x01,
  CLOSE: 0x02,
  ERROR_GLOBAL: 0x03,
  HANDSHAKE: 0x04,
  CHAT_START: 0x10,
  CHAT_EVENT: 0x11,
  CHAT_DONE: 0x12,
  CHAT_ERROR: 0x13,
  CHAT_CANCEL: 0x14,
  CHAT_ANSWER: 0x15,
  REQ: 0x20,
  RESP: 0x21,
} as const;
export type Opcode = (typeof Opcode)[keyof typeof Opcode];
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: PASS — all constant assertions green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/frame.ts packages/relay-protocol/src/frame.test.ts
git commit -m "feat(relay-protocol): frame constants, opcodes, direction, flags"
```

---

## Task 9: Inner frame encode/decode (16-byte big-endian header)

**Files:** Test `packages/relay-protocol/src/frame.test.ts` (extend), Modify `packages/relay-protocol/src/frame.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/frame.test.ts`:
```ts
import { decodeInnerFrame, encodeInnerFrame, type InnerFrame } from './frame.js';

describe('inner frame encode/decode', () => {
  it('round-trips header fields and payload', () => {
    const frame: InnerFrame = {
      ver: INNER_VER,
      type: Opcode.CHAT_EVENT,
      flags: FrameFlags.FINAL,
      streamId: 0x01020304,
      chunkIndex: 0x0a0b0c0d,
      payload: new TextEncoder().encode('{"seq":1}'),
    };
    const bytes = encodeInnerFrame(frame);
    expect(bytes.length).toBe(INNER_HEADER_LEN + frame.payload.length);
    const decoded = decodeInnerFrame(bytes);
    expect(decoded.ver).toBe(frame.ver);
    expect(decoded.type).toBe(frame.type);
    expect(decoded.flags).toBe(frame.flags);
    expect(decoded.streamId).toBe(frame.streamId);
    expect(decoded.chunkIndex).toBe(frame.chunkIndex);
    expect([...decoded.payload]).toEqual([...frame.payload]);
  });

  it('lays out the header big-endian with reserved=0', () => {
    const bytes = encodeInnerFrame({
      ver: 1,
      type: 0x11,
      flags: 0x03,
      streamId: 0x00000002,
      chunkIndex: 0x00000005,
      payload: new Uint8Array(0),
    });
    expect([...bytes.subarray(0, 4)]).toEqual([1, 0x11, 0x03, 0]); // ver,type,flags,reserved
    expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 0, 2]); // streamId BE
    expect([...bytes.subarray(8, 12)]).toEqual([0, 0, 0, 5]); // chunkIndex BE
    expect([...bytes.subarray(12, 16)]).toEqual([0, 0, 0, 0]); // payloadLen=0 BE
  });

  it('rejects a short buffer', () => {
    expect(() => decodeInnerFrame(new Uint8Array(10))).toThrow(/inner frame too short/);
  });

  it('rejects an unknown inner version', () => {
    const bytes = encodeInnerFrame({
      ver: 1,
      type: 0x00,
      flags: 0,
      streamId: 0,
      chunkIndex: 0,
      payload: new Uint8Array(0),
    });
    bytes[0] = 2; // corrupt ver
    expect(() => decodeInnerFrame(bytes)).toThrow(/unsupported inner version/);
  });

  it('rejects a payloadLen that disagrees with the buffer', () => {
    const bytes = encodeInnerFrame({
      ver: 1,
      type: 0x00,
      flags: 0,
      streamId: 0,
      chunkIndex: 0,
      payload: new Uint8Array([1, 2, 3]),
    });
    bytes[15] = 0xff; // claim payloadLen 255 but only 3 bytes present
    expect(() => decodeInnerFrame(bytes)).toThrow(/payloadLen mismatch/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: FAIL — no exported member `encodeInnerFrame` / `decodeInnerFrame` / type `InnerFrame`.

- [ ] **Step 3: Write minimal implementation** — add the import at the top of `frame.ts`:
```ts
import { concatBytes, readUint32BE, writeUint32BE } from './bytes.js';
```
Then append to `frame.ts`:
```ts
export interface InnerFrame {
  ver: number;
  type: number;
  flags: number;
  streamId: number;
  chunkIndex: number;
  payload: Uint8Array;
}

export function encodeInnerFrame(frame: InnerFrame): Uint8Array {
  const header = new Uint8Array(INNER_HEADER_LEN);
  header[0] = frame.ver & 0xff;
  header[1] = frame.type & 0xff;
  header[2] = frame.flags & 0xff;
  header[3] = 0; // reserved
  header.set(writeUint32BE(frame.streamId), 4);
  header.set(writeUint32BE(frame.chunkIndex), 8);
  header.set(writeUint32BE(frame.payload.length), 12);
  return concatBytes(header, frame.payload);
}

export function decodeInnerFrame(bytes: Uint8Array): InnerFrame {
  if (bytes.length < INNER_HEADER_LEN) throw new Error('inner frame too short');
  const ver = bytes[0];
  if (ver !== INNER_VER) throw new Error(`unsupported inner version ${ver}`);
  const type = bytes[1];
  const flags = bytes[2];
  const streamId = readUint32BE(bytes, 4);
  const chunkIndex = readUint32BE(bytes, 8);
  const payloadLen = readUint32BE(bytes, 12);
  if (payloadLen !== bytes.length - INNER_HEADER_LEN) throw new Error('payloadLen mismatch');
  const payload = bytes.subarray(INNER_HEADER_LEN);
  return { ver, type, flags, streamId, chunkIndex, payload };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: PASS — round-trip, BE layout, and all 3 rejection cases green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/frame.ts packages/relay-protocol/src/frame.test.ts
git commit -m "feat(relay-protocol): inner frame encode/decode"
```

---

## Task 10: Outer AEAD record seal/open (10-byte AAD header, counter nonce)

**Files:** Test `packages/relay-protocol/src/frame.test.ts` (extend), Modify `packages/relay-protocol/src/frame.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/frame.test.ts`:
```ts
import { openRecord, type OuterHeader, sealRecord } from './frame.js';

describe('outer AEAD record', () => {
  const key = new Uint8Array(32).fill(5);
  const inner = encodeInnerFrame({
    ver: 1,
    type: Opcode.CHAT_EVENT,
    flags: FrameFlags.FINAL,
    streamId: 2,
    chunkIndex: 0,
    payload: new TextEncoder().encode('{"event":"x"}'),
  });

  it('seals with a 10-byte outer header AAD and opens back', () => {
    const header: OuterHeader = {
      protoVer: PROTO_VER,
      direction: Direction.GW_TO_PHONE,
      recordSeq: 7n,
    };
    const sealed = sealRecord(key, header, inner);
    // ws message = 10-byte header || ciphertext || 16-byte tag
    expect(sealed.bytes.length).toBe(OUTER_HEADER_LEN + inner.length + AEAD_TAG_LEN);
    expect([...sealed.bytes.subarray(0, 2)]).toEqual([PROTO_VER, Direction.GW_TO_PHONE]);
    expect([...sealed.bytes.subarray(2, 10)]).toEqual([0, 0, 0, 0, 0, 0, 0, 7]); // recordSeq BE

    const opened = openRecord(key, sealed.bytes, Direction.GW_TO_PHONE);
    expect(opened.header.recordSeq).toBe(7n);
    expect(opened.header.direction).toBe(Direction.GW_TO_PHONE);
    expect([...opened.innerFrameBytes]).toEqual([...inner]);
  });

  it('rejects a record whose direction does not match the expected direction', () => {
    const header: OuterHeader = {
      protoVer: PROTO_VER,
      direction: Direction.PHONE_TO_GW,
      recordSeq: 1n,
    };
    const sealed = sealRecord(key, header, inner);
    expect(() => openRecord(key, sealed.bytes, Direction.GW_TO_PHONE)).toThrow(/direction mismatch/);
  });

  it('rejects a tampered header byte (AAD is authenticated)', () => {
    const header: OuterHeader = {
      protoVer: PROTO_VER,
      direction: Direction.GW_TO_PHONE,
      recordSeq: 3n,
    };
    const sealed = sealRecord(key, header, inner);
    sealed.bytes[2] ^= 0xff; // flip a recordSeq byte without re-sealing
    expect(() => openRecord(key, sealed.bytes, Direction.GW_TO_PHONE)).toThrow();
  });

  it('rejects an unsupported protoVer', () => {
    const header: OuterHeader = {
      protoVer: PROTO_VER,
      direction: Direction.GW_TO_PHONE,
      recordSeq: 1n,
    };
    const sealed = sealRecord(key, header, inner);
    sealed.bytes[0] = 9; // corrupt protoVer
    expect(() => openRecord(key, sealed.bytes, Direction.GW_TO_PHONE)).toThrow(/unsupported protoVer/);
  });

  it('rejects a too-short ws message', () => {
    expect(() => openRecord(key, new Uint8Array(5), Direction.GW_TO_PHONE)).toThrow(/record too short/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: FAIL — no exported member `sealRecord` / `openRecord` / type `OuterHeader`.

- [ ] **Step 3: Write minimal implementation** — extend the top-of-file imports in `frame.ts`:
```ts
import {
  concatBytes,
  readUint32BE,
  readUint64BE,
  writeUint32BE,
  writeUint64BE,
} from './bytes.js';
import { aeadOpen, aeadSeal, counterNonce } from './crypto.js';
```
Then append to `frame.ts`:
```ts
export interface OuterHeader {
  protoVer: number;
  direction: Direction;
  recordSeq: bigint;
}

export interface SealedRecord {
  header: OuterHeader;
  bytes: Uint8Array;
}

function encodeOuterHeader(header: OuterHeader): Uint8Array {
  const out = new Uint8Array(OUTER_HEADER_LEN);
  out[0] = header.protoVer & 0xff;
  out[1] = header.direction & 0xff;
  out.set(writeUint64BE(header.recordSeq), 2);
  return out;
}

export function sealRecord(
  key: Uint8Array,
  header: OuterHeader,
  innerFrameBytes: Uint8Array,
): SealedRecord {
  const aad = encodeOuterHeader(header);
  const nonce = counterNonce(header.recordSeq);
  const sealed = aeadSeal(key, nonce, aad, innerFrameBytes); // ciphertext || tag
  return { header, bytes: concatBytes(aad, sealed) };
}

export function openRecord(
  key: Uint8Array,
  wsMessage: Uint8Array,
  expectedDirection: Direction,
): { header: OuterHeader; innerFrameBytes: Uint8Array } {
  if (wsMessage.length < OUTER_HEADER_LEN + AEAD_TAG_LEN) throw new Error('record too short');
  const aad = wsMessage.subarray(0, OUTER_HEADER_LEN);
  const protoVer = aad[0];
  if (protoVer !== PROTO_VER) throw new Error(`unsupported protoVer ${protoVer}`);
  const direction = aad[1] as Direction;
  if (direction !== expectedDirection) throw new Error('direction mismatch');
  const recordSeq = readUint64BE(aad, 2);
  const nonce = counterNonce(recordSeq);
  const sealed = wsMessage.subarray(OUTER_HEADER_LEN);
  const innerFrameBytes = aeadOpen(key, nonce, aad, sealed); // throws on auth failure
  return { header: { protoVer, direction, recordSeq }, innerFrameBytes };
}
```
**Note on `readUint32BE`/`writeUint32BE`:** they are already used by Task 9's code and remain in the import list. Biome's `organizeImports` keeps the single merged `./bytes.js` import. If lint complains about an unused import after this edit, run `npm run lint:fix`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: PASS — seal/open round-trip plus all 4 rejection cases green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/frame.ts packages/relay-protocol/src/frame.test.ts
git commit -m "feat(relay-protocol): outer AEAD record seal/open with direction-bound AAD"
```

---

## Task 11: recordSeq monotonicity guard (receiver-side)

**Files:** Test `packages/relay-protocol/src/frame.test.ts` (extend), Modify `packages/relay-protocol/src/frame.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/frame.test.ts`:
```ts
import { RecordSeqGuard } from './frame.js';

describe('RecordSeqGuard', () => {
  it('starts with last = -1n and accepts strictly increasing seqs', () => {
    const guard = new RecordSeqGuard();
    expect(guard.last).toBe(-1n);
    expect(guard.accept(0n)).toBe(true);
    expect(guard.accept(1n)).toBe(true);
    expect(guard.last).toBe(1n);
  });

  it('rejects a replayed (equal) seq', () => {
    const guard = new RecordSeqGuard();
    guard.accept(0n);
    expect(guard.accept(0n)).toBe(false);
  });

  it('rejects a regressed (smaller) seq', () => {
    const guard = new RecordSeqGuard();
    guard.accept(5n);
    expect(guard.accept(4n)).toBe(false);
  });

  it('allows a gap forward (out-of-order delivery is the relay forwarding verbatim)', () => {
    const guard = new RecordSeqGuard();
    guard.accept(0n);
    expect(guard.accept(10n)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: FAIL — no exported member `RecordSeqGuard`.

- [ ] **Step 3: Write minimal implementation** — append to `packages/relay-protocol/src/frame.ts`:
```ts
export class RecordSeqGuard {
  #last = -1n;

  get last(): bigint {
    return this.#last;
  }

  accept(seq: bigint): boolean {
    if (seq <= this.#last) return false;
    this.#last = seq;
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: PASS — monotonicity, replay rejection, regression rejection, forward-gap acceptance all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/frame.ts packages/relay-protocol/src/frame.test.ts
git commit -m "feat(relay-protocol): recordSeq monotonicity guard"
```

---

## Task 12: Chunk split (single + multi, FINAL/CHUNKED flags)

**Files:** Test `packages/relay-protocol/src/frame.test.ts` (extend), Modify `packages/relay-protocol/src/frame.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/frame.test.ts`:
```ts
import { splitChunks } from './frame.js';

describe('splitChunks', () => {
  it('emits a single FINAL non-CHUNKED frame for small payloads', () => {
    const payload = new TextEncoder().encode('small');
    const frames = splitChunks(Opcode.RESP, 4, payload);
    expect(frames.length).toBe(1);
    expect(frames[0].chunkIndex).toBe(0);
    expect(frames[0].flags & FrameFlags.FINAL).toBe(FrameFlags.FINAL);
    expect(frames[0].flags & FrameFlags.CHUNKED).toBe(0);
    expect([...frames[0].payload]).toEqual([...payload]);
  });

  it('handles an empty payload as a single FINAL frame', () => {
    const frames = splitChunks(Opcode.CHAT_DONE, 2, new Uint8Array(0));
    expect(frames.length).toBe(1);
    expect(frames[0].flags & FrameFlags.FINAL).toBe(FrameFlags.FINAL);
    expect(frames[0].payload.length).toBe(0);
  });

  it('splits a payload larger than MAX_FRAME_PAYLOAD into CHUNKED frames', () => {
    const payload = new Uint8Array(MAX_FRAME_PAYLOAD + 100).fill(0xab);
    const frames = splitChunks(Opcode.RESP, 6, payload);
    expect(frames.length).toBe(2);
    expect(frames[0].chunkIndex).toBe(0);
    expect(frames[1].chunkIndex).toBe(1);
    expect(frames[0].flags & FrameFlags.CHUNKED).toBe(FrameFlags.CHUNKED);
    expect(frames[1].flags & FrameFlags.CHUNKED).toBe(FrameFlags.CHUNKED);
    expect(frames[0].flags & FrameFlags.FINAL).toBe(0);
    expect(frames[1].flags & FrameFlags.FINAL).toBe(FrameFlags.FINAL);
    expect(frames[0].payload.length).toBe(MAX_FRAME_PAYLOAD);
    expect(frames[1].payload.length).toBe(100);
    expect(frames.every((f) => f.type === Opcode.RESP && f.streamId === 6)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: FAIL — no exported member `splitChunks`.

- [ ] **Step 3: Write minimal implementation** — append to `packages/relay-protocol/src/frame.ts`:
```ts
export function splitChunks(type: number, streamId: number, payload: Uint8Array): InnerFrame[] {
  if (payload.length <= MAX_FRAME_PAYLOAD) {
    return [
      {
        ver: INNER_VER,
        type,
        flags: FrameFlags.FINAL,
        streamId,
        chunkIndex: 0,
        payload,
      },
    ];
  }
  const frames: InnerFrame[] = [];
  const total = Math.ceil(payload.length / MAX_FRAME_PAYLOAD);
  for (let i = 0; i < total; i += 1) {
    const start = i * MAX_FRAME_PAYLOAD;
    const end = Math.min(start + MAX_FRAME_PAYLOAD, payload.length);
    const isLast = i === total - 1;
    frames.push({
      ver: INNER_VER,
      type,
      flags: FrameFlags.CHUNKED | (isLast ? FrameFlags.FINAL : 0),
      streamId,
      chunkIndex: i,
      payload: payload.subarray(start, end),
    });
  }
  return frames;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: PASS — single, empty, and multi-chunk cases green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/frame.ts packages/relay-protocol/src/frame.test.ts
git commit -m "feat(relay-protocol): chunk split with FINAL/CHUNKED flags"
```

---

## Task 13: Chunk reassembly (happy path + gap/dup/cap fatal errors)

**Files:** Test `packages/relay-protocol/src/frame.test.ts` (extend), Modify `packages/relay-protocol/src/frame.ts`

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/frame.test.ts`:
```ts
import { ChunkReassembler } from './frame.js';

const chunkFrame = (chunkIndex: number, len: number): InnerFrame => ({
  ver: 1,
  type: Opcode.RESP,
  flags: FrameFlags.CHUNKED,
  streamId: 6,
  chunkIndex,
  payload: new Uint8Array(len),
});

describe('ChunkReassembler', () => {
  it('returns the full payload immediately for a single FINAL frame', () => {
    const r = new ChunkReassembler();
    const out = r.push({
      ver: 1,
      type: Opcode.RESP,
      flags: FrameFlags.FINAL,
      streamId: 4,
      chunkIndex: 0,
      payload: new TextEncoder().encode('only'),
    });
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out as Uint8Array)).toBe('only');
  });

  it('reassembles multi-chunk frames in order, returning null until FINAL', () => {
    const payload = new Uint8Array(MAX_FRAME_PAYLOAD + 50).fill(0xcd);
    const frames = splitChunks(Opcode.RESP, 6, payload);
    const r = new ChunkReassembler();
    expect(r.push(frames[0])).toBeNull();
    const out = r.push(frames[1]);
    expect(out).not.toBeNull();
    expect((out as Uint8Array).length).toBe(payload.length);
    expect([...(out as Uint8Array)]).toEqual([...payload]);
  });

  it('throws on a chunkIndex gap (out-of-order)', () => {
    const r = new ChunkReassembler();
    r.push(chunkFrame(0, 1));
    expect(() => r.push(chunkFrame(2, 1))).toThrow(/chunk order violation/);
  });

  it('throws on a duplicate chunkIndex', () => {
    const r = new ChunkReassembler();
    r.push(chunkFrame(0, 1));
    expect(() => r.push(chunkFrame(0, 1))).toThrow(/chunk order violation/);
  });

  it('throws when reassembly exceeds MAX_REASSEMBLY', () => {
    const r = new ChunkReassembler();
    const full = MAX_FRAME_PAYLOAD;
    // 32 full chunks = 32 MiB exactly (at the cap); the 33rd would exceed it.
    for (let i = 0; i < 32; i += 1) r.push(chunkFrame(i, full));
    expect(() => r.push(chunkFrame(32, 1))).toThrow(/reassembly cap exceeded/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: FAIL — no exported member `ChunkReassembler`.

- [ ] **Step 3: Write minimal implementation** — append to `packages/relay-protocol/src/frame.ts`:
```ts
export class ChunkReassembler {
  #chunks: Uint8Array[] = [];
  #nextIndex = 0;
  #total = 0;

  push(frame: InnerFrame): Uint8Array | null {
    const isChunked = (frame.flags & FrameFlags.CHUNKED) !== 0;
    const isFinal = (frame.flags & FrameFlags.FINAL) !== 0;

    if (!isChunked) {
      // single-frame message: must be the very first frame and is complete on arrival.
      if (this.#nextIndex !== 0) throw new Error('chunk order violation');
      return frame.payload;
    }

    if (frame.chunkIndex !== this.#nextIndex) throw new Error('chunk order violation');
    this.#total += frame.payload.length;
    if (this.#total > MAX_REASSEMBLY) throw new Error('reassembly cap exceeded');
    this.#chunks.push(frame.payload);
    this.#nextIndex += 1;

    if (!isFinal) return null;
    return concatBytes(...this.#chunks);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/frame.test.ts
```
Expected: PASS — happy path, gap, dup, and cap-exceeded cases green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/frame.ts packages/relay-protocol/src/frame.test.ts
git commit -m "feat(relay-protocol): chunk reassembly with fatal gap/dup/cap errors"
```

---

## Task 14: Handshake transcript builder

**Files:** Test `packages/relay-protocol/src/handshake.test.ts`, Create `packages/relay-protocol/src/handshake.ts`

The transcript is the canonical, ordered concatenation that becomes the HKDF salt (via SHA-256). Both sides must build byte-identical transcripts, so the order is frozen here: `"dash-v1" ‖ linkId ‖ S_g.pub ‖ S_p.pub ‖ E_g.pub ‖ E_p.pub ‖ gwNonce ‖ phNonce` (gateway-perspective ordering; the phone uses the same labels for the same roles).

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/handshake.test.ts`:
```ts
import { utf8Encode } from './bytes.js';
import { buildTranscript, type HandshakeInputs } from './handshake.js';

const inputs: HandshakeInputs = {
  linkId: 'a4u-r_vZhRw5yqV0hY4LL1I4zNmpwGDi',
  gwStaticPub: new Uint8Array(32).fill(0x11),
  phoneStaticPub: new Uint8Array(32).fill(0x22),
  gwEphemeralPub: new Uint8Array(32).fill(0x33),
  phoneEphemeralPub: new Uint8Array(32).fill(0x44),
  gwNonce: new Uint8Array(16).fill(0x55),
  phoneNonce: new Uint8Array(16).fill(0x66),
};

describe('buildTranscript', () => {
  it('concatenates "dash-v1" || linkId || statics || ephemerals || nonces in order', () => {
    const t = buildTranscript(inputs);
    const expectedLen = 'dash-v1'.length + inputs.linkId.length + 32 + 32 + 32 + 32 + 16 + 16;
    expect(t.length).toBe(expectedLen);
    // prefix is the ascii label "dash-v1"
    expect([...t.subarray(0, 7)]).toEqual([...utf8Encode('dash-v1')]);
    // linkId is ascii right after the label
    const linkStart = 7;
    expect([...t.subarray(linkStart, linkStart + inputs.linkId.length)]).toEqual([
      ...utf8Encode(inputs.linkId),
    ]);
  });

  it('is deterministic and changes when any nonce changes', () => {
    const a = buildTranscript(inputs);
    const b = buildTranscript({ ...inputs, gwNonce: new Uint8Array(16).fill(0x99) });
    expect([...a]).not.toEqual([...b]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: FAIL — `Failed to resolve import "./handshake.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/relay-protocol/src/handshake.ts`:
```ts
import { concatBytes, utf8Encode } from './bytes.js';

export const HANDSHAKE_LABELS = {
  G2P: 'dash g2p key',
  P2G: 'dash p2g key',
  CFM_G: 'dash confirm g',
  CFM_P: 'dash confirm p',
  SAS: 'dash-sas',
} as const;

export const TRANSCRIPT_PREFIX = 'dash-v1';
export const PROVISION_PREFIX = 'dash-pair-v1';
export const SLOT_AUTH_PREFIX = 'dash-slot-v1';
export const SAS_DIGITS = 6;

export interface HandshakeInputs {
  linkId: string;
  gwStaticPub: Uint8Array;
  phoneStaticPub: Uint8Array;
  gwEphemeralPub: Uint8Array;
  phoneEphemeralPub: Uint8Array;
  gwNonce: Uint8Array;
  phoneNonce: Uint8Array;
}

export function buildTranscript(inputs: HandshakeInputs): Uint8Array {
  return concatBytes(
    utf8Encode(TRANSCRIPT_PREFIX),
    utf8Encode(inputs.linkId),
    inputs.gwStaticPub,
    inputs.phoneStaticPub,
    inputs.gwEphemeralPub,
    inputs.phoneEphemeralPub,
    inputs.gwNonce,
    inputs.phoneNonce,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: PASS — transcript length, label/linkId prefix, determinism green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/handshake.ts packages/relay-protocol/src/handshake.test.ts
git commit -m "feat(relay-protocol): handshake transcript builder"
```

---

## Task 15: SAS computation + provisioning tag

**Files:** Test `packages/relay-protocol/src/handshake.test.ts` (extend), Modify `packages/relay-protocol/src/handshake.ts`

The SAS is `readUint32BE(HMAC(PRK, "dash-sas"), 0) % 1_000_000`, zero-padded to 6 digits. The provisioning tag is `HMAC(psk, "dash-pair-v1" ‖ linkId ‖ S_g.pub ‖ S_p.pub ‖ phoneNonce)` — it lets the gateway detect a relay that swapped the phone's static key (the attacker lacks `psk`).

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/handshake.test.ts`:
```ts
import { hmacSha256 } from './crypto.js';
import { computeSas, pairingProvisionTag, SAS_DIGITS } from './handshake.js';

describe('computeSas', () => {
  it('returns a zero-padded 6-digit decimal string', () => {
    const prk = new Uint8Array(32).fill(9);
    const sas = computeSas(prk);
    expect(sas).toMatch(/^[0-9]{6}$/);
    expect(sas.length).toBe(SAS_DIGITS);
  });

  it('matches the documented derivation: readUint32BE(HMAC(prk,"dash-sas")) % 1e6', () => {
    const prk = new Uint8Array(32).fill(9);
    const mac = hmacSha256(prk, new TextEncoder().encode('dash-sas'));
    const n = (((mac[0] * 2 ** 24) + (mac[1] << 16) + (mac[2] << 8) + mac[3]) >>> 0) % 1_000_000;
    expect(computeSas(prk)).toBe(String(n).padStart(6, '0'));
  });

  it('changes when the PRK changes', () => {
    expect(computeSas(new Uint8Array(32).fill(1))).not.toBe(computeSas(new Uint8Array(32).fill(2)));
  });
});

describe('pairingProvisionTag', () => {
  const base = {
    psk: new Uint8Array(32).fill(0xaa),
    linkId: 'a4u-r_vZhRw5yqV0hY4LL1I4zNmpwGDi',
    gwStaticPub: new Uint8Array(32).fill(0x11),
    phoneStaticPub: new Uint8Array(32).fill(0x22),
    phoneNonce: new Uint8Array(16).fill(0x66),
  };

  it('is a 32-byte HMAC over the canonical pairing input', () => {
    expect(pairingProvisionTag(base).length).toBe(32);
  });

  it('changes when the phone static key changes (key-swap detection)', () => {
    const a = pairingProvisionTag(base);
    const b = pairingProvisionTag({ ...base, phoneStaticPub: new Uint8Array(32).fill(0x23) });
    expect([...a]).not.toEqual([...b]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: FAIL — no exported members `computeSas` / `pairingProvisionTag`.

- [ ] **Step 3: Write minimal implementation** — extend the imports at the top of `handshake.ts`:
```ts
import { concatBytes, readUint32BE, utf8Encode } from './bytes.js';
import { hmacSha256 } from './crypto.js';
```
Then append to `handshake.ts`:
```ts
export function computeSas(prk: Uint8Array): string {
  const mac = hmacSha256(prk, utf8Encode(HANDSHAKE_LABELS.SAS));
  const modulus = 10 ** SAS_DIGITS;
  const value = readUint32BE(mac, 0) % modulus;
  return String(value).padStart(SAS_DIGITS, '0');
}

export function pairingProvisionTag(args: {
  psk: Uint8Array;
  linkId: string;
  gwStaticPub: Uint8Array;
  phoneStaticPub: Uint8Array;
  phoneNonce: Uint8Array;
}): Uint8Array {
  const msg = concatBytes(
    utf8Encode(PROVISION_PREFIX),
    utf8Encode(args.linkId),
    args.gwStaticPub,
    args.phoneStaticPub,
    args.phoneNonce,
  );
  return hmacSha256(args.psk, msg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: PASS — SAS format, derivation, sensitivity; provisioning tag length + key-swap detection all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/handshake.ts packages/relay-protocol/src/handshake.test.ts
git commit -m "feat(relay-protocol): SAS computation and pairing provision tag"
```

---

## Task 16: Session key derivation (deriveSessionKeys; psk-folded and psk-omitted)

**Files:** Test `packages/relay-protocol/src/handshake.test.ts` (extend), Modify `packages/relay-protocol/src/handshake.ts`

Canonical derivation (both sides build identical inputs):
- `IKM = ss_ee ‖ ss_se ‖ ss_es` (gateway-perspective order; `‖ psk` appended for **pairing only**).
- `salt = SHA-256(transcript)`.
- `PRK = HKDF-Extract(salt, IKM)`.
- `k_g2p = HKDF-Expand(PRK, "dash g2p key", 32)`, `k_p2g = "dash p2g key"`, `cfm_g = "dash confirm g"`, `cfm_p = "dash confirm p"`.
- `sas = computeSas(PRK)`.

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/handshake.test.ts`:
```ts
import { concatBytes } from './bytes.js';
import { hkdfExpand, hkdfExtract, sha256 } from './crypto.js';
import { deriveSessionKeys, HANDSHAKE_LABELS, type SessionKeys } from './handshake.js';

const ssEe = new Uint8Array(32).fill(0xa1);
const ssSe = new Uint8Array(32).fill(0xb2);
const ssEs = new Uint8Array(32).fill(0xc3);
const transcript = buildTranscript(inputs); // `inputs` defined at the top of this file in Task 14
const psk = new Uint8Array(32).fill(0xd4);

describe('deriveSessionKeys', () => {
  it('produces five 32-byte keys plus a 6-digit SAS', () => {
    const keys: SessionKeys = deriveSessionKeys({ ssEe, ssSe, ssEs, transcript, psk });
    expect(keys.prk.length).toBe(32);
    expect(keys.kG2p.length).toBe(32);
    expect(keys.kP2g.length).toBe(32);
    expect(keys.cfmG.length).toBe(32);
    expect(keys.cfmP.length).toBe(32);
    expect(keys.sas).toMatch(/^[0-9]{6}$/);
  });

  it('matches the manual reference derivation (psk folded into IKM)', () => {
    const salt = sha256(transcript);
    const ikm = concatBytes(ssEe, ssSe, ssEs, psk);
    const prk = hkdfExtract(salt, ikm);
    const enc = new TextEncoder();
    const k = deriveSessionKeys({ ssEe, ssSe, ssEs, transcript, psk });
    expect([...k.kG2p]).toEqual([...hkdfExpand(prk, enc.encode(HANDSHAKE_LABELS.G2P), 32)]);
    expect([...k.cfmP]).toEqual([...hkdfExpand(prk, enc.encode(HANDSHAKE_LABELS.CFM_P), 32)]);
  });

  it('omitting psk changes the PRK (per-session vs pairing produce different keys)', () => {
    const withPsk = deriveSessionKeys({ ssEe, ssSe, ssEs, transcript, psk });
    const noPsk = deriveSessionKeys({ ssEe, ssSe, ssEs, transcript });
    expect([...withPsk.prk]).not.toEqual([...noPsk.prk]);
    expect([...withPsk.kG2p]).not.toEqual([...noPsk.kG2p]);
  });

  it('directional keys differ (g2p != p2g)', () => {
    const k = deriveSessionKeys({ ssEe, ssSe, ssEs, transcript, psk });
    expect([...k.kG2p]).not.toEqual([...k.kP2g]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: FAIL — no exported member `deriveSessionKeys` / type `SessionKeys`.

- [ ] **Step 3: Write minimal implementation** — extend the imports at the top of `handshake.ts` to add `hkdfExpand, hkdfExtract, sha256`:
```ts
import { concatBytes, readUint32BE, utf8Encode } from './bytes.js';
import { hkdfExpand, hkdfExtract, hmacSha256, sha256 } from './crypto.js';
```
Then append to `handshake.ts`:
```ts
export interface SessionKeys {
  prk: Uint8Array;
  kG2p: Uint8Array;
  kP2g: Uint8Array;
  cfmG: Uint8Array;
  cfmP: Uint8Array;
  sas: string;
}

export function deriveSessionKeys(args: {
  ssEe: Uint8Array;
  ssSe: Uint8Array;
  ssEs: Uint8Array;
  transcript: Uint8Array;
  psk?: Uint8Array;
}): SessionKeys {
  const salt = sha256(args.transcript);
  const ikm = args.psk
    ? concatBytes(args.ssEe, args.ssSe, args.ssEs, args.psk)
    : concatBytes(args.ssEe, args.ssSe, args.ssEs);
  const prk = hkdfExtract(salt, ikm);
  return {
    prk,
    kG2p: hkdfExpand(prk, utf8Encode(HANDSHAKE_LABELS.G2P), 32),
    kP2g: hkdfExpand(prk, utf8Encode(HANDSHAKE_LABELS.P2G), 32),
    cfmG: hkdfExpand(prk, utf8Encode(HANDSHAKE_LABELS.CFM_G), 32),
    cfmP: hkdfExpand(prk, utf8Encode(HANDSHAKE_LABELS.CFM_P), 32),
    sas: computeSas(prk),
  };
}
```
(`computeSas` and `hmacSha256` are already in scope from Task 15.)

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: PASS — key sizes, manual-reference equality, psk presence sensitivity, directional difference all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/handshake.ts packages/relay-protocol/src/handshake.test.ts
git commit -m "feat(relay-protocol): session key derivation (psk-folded and per-session)"
```

---

## Task 17: Slot-auth proof + commitment helpers

**Files:** Test `packages/relay-protocol/src/handshake.test.ts` (extend), Modify `packages/relay-protocol/src/handshake.ts`

These are the cryptographic core of the **relay-join** challenge-response (the message *wire format* is Task 18). The relay never authorizes the E2E peer — these are an anti-DoS slot claim only. This package supplies the canonical *constructions* both sides compute; the relay's verification policy lives in Unit B.

- **Commitment** (computed by the client at pairing, registered with the relay DO once, stored as `slotSecretHash`): `slotSecretHash = SHA-256(slotSecret)`.
- **Per-(re)connect proof**: `slotProof = HMAC(slotSecret, "dash-slot-v1" ‖ challenge)`, where `challenge` is the DO's fresh 16 CSPRNG bytes. The client sends `{ slotProof, slotSecretHash }` in its `SLOT_AUTH` message.
- **How the relay verifies (Unit B, summarized here so the construction is unambiguous):** on the first slot claim, the relay learns `slotSecret` itself once (the phone presents it during slot-auth so the relay can validate the HMAC) and immediately discards it, persisting only `slotSecretHash`. On every later (re)connect the relay re-challenges and recomputes `HMAC(slotSecret, "dash-slot-v1" ‖ challenge)` to compare against the presented `slotProof`, while also confirming the presented `slotSecretHash` matches the stored hash. Because the challenge is fresh per connect, a captured URL or a replayed `slotProof` from a prior challenge is rejected. The exact storage/eviction policy is Unit B's; the helpers below are the single source of truth for the values.

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/handshake.test.ts`:
```ts
import { slotSecretCommitment, slotAuthProof } from './handshake.js';

describe('slot-auth construction', () => {
  const slotSecret = new Uint8Array(32).fill(0x7e);
  const challenge = new Uint8Array(16).fill(0x42);

  it('commitment is sha256(slotSecret) (32 bytes)', () => {
    const commit = slotSecretCommitment(slotSecret);
    expect(commit.length).toBe(32);
    // deterministic
    expect([...commit]).toEqual([...slotSecretCommitment(slotSecret)]);
  });

  it('proof is a 32-byte HMAC(slotSecret, "dash-slot-v1" || challenge)', () => {
    const proof = slotAuthProof(slotSecret, challenge);
    expect(proof.length).toBe(32);
  });

  it('proof changes when the challenge changes (not replayable across challenges)', () => {
    const a = slotAuthProof(slotSecret, challenge);
    const b = slotAuthProof(slotSecret, new Uint8Array(16).fill(0x43));
    expect([...a]).not.toEqual([...b]);
  });

  it('proof changes when the slotSecret changes', () => {
    const a = slotAuthProof(slotSecret, challenge);
    const b = slotAuthProof(new Uint8Array(32).fill(0x7f), challenge);
    expect([...a]).not.toEqual([...b]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: FAIL — no exported members `slotSecretCommitment` / `slotAuthProof`.

- [ ] **Step 3: Write minimal implementation** — append to `packages/relay-protocol/src/handshake.ts` (imports already in scope: `concatBytes`, `utf8Encode`, `hmacSha256`, `sha256`):
```ts
export function slotSecretCommitment(slotSecret: Uint8Array): Uint8Array {
  return sha256(slotSecret);
}

export function slotAuthProof(slotSecret: Uint8Array, challenge: Uint8Array): Uint8Array {
  return hmacSha256(slotSecret, concatBytes(utf8Encode(SLOT_AUTH_PREFIX), challenge));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/handshake.test.ts
```
Expected: PASS — commitment determinism, proof length, challenge/secret sensitivity all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/handshake.ts packages/relay-protocol/src/handshake.test.ts
git commit -m "feat(relay-protocol): slot-auth proof and commitment constructions"
```

---

## Task 18: Control plane — relay-join messages (JOIN, CHALLENGE, SLOT_AUTH, JOIN_RESULT)

**Files:** Test `packages/relay-protocol/src/control.test.ts`, Create `packages/relay-protocol/src/control.ts`

**THIS IS THE KEY ADDITION.** These messages are the relay-join signaling that the relay DO (Unit B), gateway tunnel-client (Unit C), and CLI harness (Unit D) all exchange. They are sent as **WebSocket binary** messages (NOT JSON, so TS and Kotlin agree byte-for-byte). Every control message starts with a 1-byte `ControlMsgType` discriminator. The first byte distinguishes a control message (`0x80`–`0xFF` range) from a data-plane AEAD record (whose first byte is `protoVer = 0x01`), so a peer can route an inbound binary message by its leading byte during the join phase.

Canonical relay-join wire layouts (all big-endian; lengths in bytes):

```
JOIN          [0x80][role:1][linkIdLen:2][linkId:ascii]
                role: 0x01 gateway, 0x02 phone
CHALLENGE     [0x81][challenge:16]                       (DO -> client; fresh CSPRNG per (re)connect)
SLOT_AUTH     [0x82][role:1][slotProof:32][slotSecretHash:32]
JOIN_RESULT   [0x83][code:1][peerPresent:1]              (DO -> client)
                code: 0x00 OK, 0x01 SLOT_TAKEN, 0x02 BAD_PROOF, 0x03 NO_PENDING_LINK,
                      0x04 RATE_LIMITED, 0x05 UNLINKED
                peerPresent: 0x00 no, 0x01 yes (the other slot is occupied)
```

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/control.test.ts`:
```ts
import {
  ControlMsgType,
  JoinResultCode,
  Role,
  decodeChallenge,
  decodeJoin,
  decodeJoinResult,
  decodeSlotAuth,
  encodeChallenge,
  encodeJoin,
  encodeJoinResult,
  encodeSlotAuth,
  peekControlMsgType,
} from './control.js';

describe('peekControlMsgType', () => {
  it('returns the leading discriminator byte', () => {
    expect(peekControlMsgType(new Uint8Array([0x80, 1, 2]))).toBe(ControlMsgType.JOIN);
  });

  it('throws on an empty buffer', () => {
    expect(() => peekControlMsgType(new Uint8Array(0))).toThrow(/empty control message/);
  });
});

describe('JOIN encode/decode', () => {
  it('round-trips role + linkId', () => {
    const linkId = 'a4u-r_vZhRw5yqV0hY4LL1I4zNmpwGDi';
    const bytes = encodeJoin({ role: Role.PHONE, linkId });
    expect(bytes[0]).toBe(ControlMsgType.JOIN);
    expect(bytes[1]).toBe(Role.PHONE);
    const decoded = decodeJoin(bytes);
    expect(decoded.role).toBe(Role.PHONE);
    expect(decoded.linkId).toBe(linkId);
  });

  it('rejects a wrong discriminator', () => {
    const bytes = encodeJoin({ role: Role.GATEWAY, linkId: 'x' });
    bytes[0] = 0x99;
    expect(() => decodeJoin(bytes)).toThrow(/not a JOIN/);
  });

  it('rejects a length-prefix that overruns the buffer', () => {
    const bytes = encodeJoin({ role: Role.GATEWAY, linkId: 'abc' });
    bytes[2] = 0xff; // claim 0xff03 linkId bytes
    expect(() => decodeJoin(bytes)).toThrow(/JOIN length mismatch/);
  });
});

describe('CHALLENGE encode/decode', () => {
  it('round-trips a 16-byte challenge', () => {
    const challenge = new Uint8Array(16).fill(0x42);
    const bytes = encodeChallenge(challenge);
    expect(bytes.length).toBe(1 + 16);
    expect(bytes[0]).toBe(ControlMsgType.CHALLENGE);
    expect([...decodeChallenge(bytes)]).toEqual([...challenge]);
  });

  it('rejects a wrong-size challenge on encode', () => {
    expect(() => encodeChallenge(new Uint8Array(15))).toThrow(/challenge must be 16 bytes/);
  });

  it('rejects a truncated CHALLENGE on decode', () => {
    expect(() => decodeChallenge(new Uint8Array([ControlMsgType.CHALLENGE, 1, 2]))).toThrow(
      /CHALLENGE length mismatch/,
    );
  });
});

describe('SLOT_AUTH encode/decode', () => {
  it('round-trips role + 32-byte proof + 32-byte hash', () => {
    const slotProof = new Uint8Array(32).fill(0xab);
    const slotSecretHash = new Uint8Array(32).fill(0xcd);
    const bytes = encodeSlotAuth({ role: Role.PHONE, slotProof, slotSecretHash });
    expect(bytes.length).toBe(1 + 1 + 32 + 32);
    expect(bytes[0]).toBe(ControlMsgType.SLOT_AUTH);
    const decoded = decodeSlotAuth(bytes);
    expect(decoded.role).toBe(Role.PHONE);
    expect([...decoded.slotProof]).toEqual([...slotProof]);
    expect([...decoded.slotSecretHash]).toEqual([...slotSecretHash]);
  });

  it('rejects wrong-size proof on encode', () => {
    expect(() =>
      encodeSlotAuth({
        role: Role.PHONE,
        slotProof: new Uint8Array(31),
        slotSecretHash: new Uint8Array(32),
      }),
    ).toThrow(/slotProof must be 32 bytes/);
  });

  it('rejects a truncated SLOT_AUTH on decode', () => {
    expect(() => decodeSlotAuth(new Uint8Array([ControlMsgType.SLOT_AUTH, Role.PHONE, 1]))).toThrow(
      /SLOT_AUTH length mismatch/,
    );
  });
});

describe('JOIN_RESULT encode/decode', () => {
  it('round-trips code + peerPresent', () => {
    const bytes = encodeJoinResult({ code: JoinResultCode.OK, peerPresent: true });
    expect(bytes.length).toBe(1 + 1 + 1);
    expect(bytes[0]).toBe(ControlMsgType.JOIN_RESULT);
    const decoded = decodeJoinResult(bytes);
    expect(decoded.code).toBe(JoinResultCode.OK);
    expect(decoded.peerPresent).toBe(true);
  });

  it('encodes peerPresent=false as 0x00', () => {
    const bytes = encodeJoinResult({ code: JoinResultCode.SLOT_TAKEN, peerPresent: false });
    expect(bytes[2]).toBe(0x00);
    expect(decodeJoinResult(bytes).peerPresent).toBe(false);
  });

  it('exposes the documented result codes', () => {
    expect(JoinResultCode.OK).toBe(0x00);
    expect(JoinResultCode.SLOT_TAKEN).toBe(0x01);
    expect(JoinResultCode.BAD_PROOF).toBe(0x02);
    expect(JoinResultCode.NO_PENDING_LINK).toBe(0x03);
    expect(JoinResultCode.RATE_LIMITED).toBe(0x04);
    expect(JoinResultCode.UNLINKED).toBe(0x05);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/control.test.ts
```
Expected: FAIL — `Failed to resolve import "./control.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/relay-protocol/src/control.ts`:
```ts
import {
  concatBytes,
  readUint16BE,
  utf8Decode,
  utf8Encode,
  writeUint16BE,
} from './bytes.js';

/**
 * Control-plane message discriminators. The leading byte of every control message.
 * Chosen in 0x80..0xFF so a peer can distinguish a control message from a data-plane
 * AEAD record (whose leading byte is the data-plane protoVer = 0x01) during the join phase.
 */
export const ControlMsgType = {
  JOIN: 0x80,
  CHALLENGE: 0x81,
  SLOT_AUTH: 0x82,
  JOIN_RESULT: 0x83,
} as const;
export type ControlMsgType = (typeof ControlMsgType)[keyof typeof ControlMsgType];

/** Slot role on the relay. */
export const Role = {
  GATEWAY: 0x01,
  PHONE: 0x02,
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Result codes the relay DO returns after a join/slot-auth attempt. */
export const JoinResultCode = {
  OK: 0x00,
  SLOT_TAKEN: 0x01,
  BAD_PROOF: 0x02,
  NO_PENDING_LINK: 0x03,
  RATE_LIMITED: 0x04,
  UNLINKED: 0x05,
} as const;
export type JoinResultCode = (typeof JoinResultCode)[keyof typeof JoinResultCode];

const CHALLENGE_LEN = 16;
const PROOF_LEN = 32;
const HASH_LEN = 32;

export interface JoinMessage {
  role: Role;
  linkId: string;
}

export interface SlotAuthMessage {
  role: Role;
  slotProof: Uint8Array;
  slotSecretHash: Uint8Array;
}

export interface JoinResultMessage {
  code: JoinResultCode;
  peerPresent: boolean;
}

export function peekControlMsgType(bytes: Uint8Array): number {
  if (bytes.length < 1) throw new Error('empty control message');
  return bytes[0];
}

export function encodeJoin(msg: JoinMessage): Uint8Array {
  const linkId = utf8Encode(msg.linkId);
  return concatBytes(
    new Uint8Array([ControlMsgType.JOIN, msg.role]),
    writeUint16BE(linkId.length),
    linkId,
  );
}

export function decodeJoin(bytes: Uint8Array): JoinMessage {
  if (bytes.length < 4) throw new Error('JOIN too short');
  if (bytes[0] !== ControlMsgType.JOIN) throw new Error('not a JOIN message');
  const role = bytes[1] as Role;
  const linkIdLen = readUint16BE(bytes, 2);
  if (bytes.length !== 4 + linkIdLen) throw new Error('JOIN length mismatch');
  return { role, linkId: utf8Decode(bytes.subarray(4, 4 + linkIdLen)) };
}

export function encodeChallenge(challenge: Uint8Array): Uint8Array {
  if (challenge.length !== CHALLENGE_LEN) throw new Error('challenge must be 16 bytes');
  return concatBytes(new Uint8Array([ControlMsgType.CHALLENGE]), challenge);
}

export function decodeChallenge(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== ControlMsgType.CHALLENGE) throw new Error('not a CHALLENGE message');
  if (bytes.length !== 1 + CHALLENGE_LEN) throw new Error('CHALLENGE length mismatch');
  return bytes.subarray(1, 1 + CHALLENGE_LEN);
}

export function encodeSlotAuth(msg: SlotAuthMessage): Uint8Array {
  if (msg.slotProof.length !== PROOF_LEN) throw new Error('slotProof must be 32 bytes');
  if (msg.slotSecretHash.length !== HASH_LEN) throw new Error('slotSecretHash must be 32 bytes');
  return concatBytes(
    new Uint8Array([ControlMsgType.SLOT_AUTH, msg.role]),
    msg.slotProof,
    msg.slotSecretHash,
  );
}

export function decodeSlotAuth(bytes: Uint8Array): SlotAuthMessage {
  if (bytes[0] !== ControlMsgType.SLOT_AUTH) throw new Error('not a SLOT_AUTH message');
  if (bytes.length !== 2 + PROOF_LEN + HASH_LEN) throw new Error('SLOT_AUTH length mismatch');
  const role = bytes[1] as Role;
  const slotProof = bytes.subarray(2, 2 + PROOF_LEN);
  const slotSecretHash = bytes.subarray(2 + PROOF_LEN, 2 + PROOF_LEN + HASH_LEN);
  return { role, slotProof, slotSecretHash };
}

export function encodeJoinResult(msg: JoinResultMessage): Uint8Array {
  return new Uint8Array([ControlMsgType.JOIN_RESULT, msg.code, msg.peerPresent ? 0x01 : 0x00]);
}

export function decodeJoinResult(bytes: Uint8Array): JoinResultMessage {
  if (bytes[0] !== ControlMsgType.JOIN_RESULT) throw new Error('not a JOIN_RESULT message');
  if (bytes.length !== 3) throw new Error('JOIN_RESULT length mismatch');
  return { code: bytes[1] as JoinResultCode, peerPresent: bytes[2] === 0x01 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/control.test.ts
```
Expected: PASS — JOIN/CHALLENGE/SLOT_AUTH/JOIN_RESULT round-trips, discriminator rejection, length-mismatch rejection, code constants all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/control.ts packages/relay-protocol/src/control.test.ts
git commit -m "feat(relay-protocol): control-plane relay-join messages"
```

---

## Task 19: Control plane — E2E handshake messages (PROVISION, EPHEMERAL, KEY_CONFIRM)

**Files:** Test `packages/relay-protocol/src/control.test.ts` (extend), Modify `packages/relay-protocol/src/control.ts`

These three messages are the **E2E handshake payloads** carried inside `Opcode.HANDSHAKE (0x04)` data-plane frames. They are NOT sealed with the transport AEAD keys (they precede them); integrity rests on the provisioning `tag` (HMAC over `psk`) and the later key-confirmation. They use a **separate discriminator family** (`HandshakeMsgType`, range `0x90`–`0x9F`) carried as the *inner-frame payload* of a `0x04` HANDSHAKE frame.

Canonical handshake-message wire layouts (all big-endian):

```
PROVISION     [0x90][phonePub:32][phoneNonce:16][tag:32]
                phone -> gateway, pairing only. tag = pairingProvisionTag(psk, linkId, S_g.pub, phonePub, phoneNonce)
EPHEMERAL     [0x91][ephemeralPub:32][connNonce:16]
                sent by each side every connection. connNonce is gwNonce (from gateway) or phNonce (from phone)
KEY_CONFIRM   [0x92][confirm:32]
                gateway sends cfm_g; phone sends cfm_p. peer compares against its locally derived value.
```

- [ ] **Step 1: Write the failing test** — append to `packages/relay-protocol/src/control.test.ts`:
```ts
import {
  HandshakeMsgType,
  decodeEphemeral,
  decodeKeyConfirm,
  decodeProvision,
  encodeEphemeral,
  encodeKeyConfirm,
  encodeProvision,
  peekHandshakeMsgType,
} from './control.js';

describe('peekHandshakeMsgType', () => {
  it('returns the leading discriminator byte', () => {
    expect(peekHandshakeMsgType(new Uint8Array([0x90]))).toBe(HandshakeMsgType.PROVISION);
  });

  it('throws on an empty buffer', () => {
    expect(() => peekHandshakeMsgType(new Uint8Array(0))).toThrow(/empty handshake message/);
  });
});

describe('PROVISION encode/decode', () => {
  it('round-trips phonePub + phoneNonce + tag', () => {
    const phonePub = new Uint8Array(32).fill(0x22);
    const phoneNonce = new Uint8Array(16).fill(0x66);
    const tag = new Uint8Array(32).fill(0x99);
    const bytes = encodeProvision({ phonePub, phoneNonce, tag });
    expect(bytes.length).toBe(1 + 32 + 16 + 32);
    expect(bytes[0]).toBe(HandshakeMsgType.PROVISION);
    const decoded = decodeProvision(bytes);
    expect([...decoded.phonePub]).toEqual([...phonePub]);
    expect([...decoded.phoneNonce]).toEqual([...phoneNonce]);
    expect([...decoded.tag]).toEqual([...tag]);
  });

  it('rejects a wrong-size phonePub on encode', () => {
    expect(() =>
      encodeProvision({
        phonePub: new Uint8Array(31),
        phoneNonce: new Uint8Array(16),
        tag: new Uint8Array(32),
      }),
    ).toThrow(/phonePub must be 32 bytes/);
  });

  it('rejects a truncated PROVISION on decode', () => {
    expect(() => decodeProvision(new Uint8Array([HandshakeMsgType.PROVISION, 1, 2]))).toThrow(
      /PROVISION length mismatch/,
    );
  });
});

describe('EPHEMERAL encode/decode', () => {
  it('round-trips ephemeralPub + connNonce', () => {
    const ephemeralPub = new Uint8Array(32).fill(0x33);
    const connNonce = new Uint8Array(16).fill(0x55);
    const bytes = encodeEphemeral({ ephemeralPub, connNonce });
    expect(bytes.length).toBe(1 + 32 + 16);
    expect(bytes[0]).toBe(HandshakeMsgType.EPHEMERAL);
    const decoded = decodeEphemeral(bytes);
    expect([...decoded.ephemeralPub]).toEqual([...ephemeralPub]);
    expect([...decoded.connNonce]).toEqual([...connNonce]);
  });

  it('rejects a wrong-size connNonce on encode', () => {
    expect(() =>
      encodeEphemeral({ ephemeralPub: new Uint8Array(32), connNonce: new Uint8Array(15) }),
    ).toThrow(/connNonce must be 16 bytes/);
  });

  it('rejects a truncated EPHEMERAL on decode', () => {
    expect(() => decodeEphemeral(new Uint8Array([HandshakeMsgType.EPHEMERAL, 1]))).toThrow(
      /EPHEMERAL length mismatch/,
    );
  });
});

describe('KEY_CONFIRM encode/decode', () => {
  it('round-trips a 32-byte confirm value', () => {
    const confirm = new Uint8Array(32).fill(0xc0);
    const bytes = encodeKeyConfirm({ confirm });
    expect(bytes.length).toBe(1 + 32);
    expect(bytes[0]).toBe(HandshakeMsgType.KEY_CONFIRM);
    expect([...decodeKeyConfirm(bytes).confirm]).toEqual([...confirm]);
  });

  it('rejects a wrong-size confirm on encode', () => {
    expect(() => encodeKeyConfirm({ confirm: new Uint8Array(31) })).toThrow(
      /confirm must be 32 bytes/,
    );
  });

  it('rejects a truncated KEY_CONFIRM on decode', () => {
    expect(() => decodeKeyConfirm(new Uint8Array([HandshakeMsgType.KEY_CONFIRM, 1, 2]))).toThrow(
      /KEY_CONFIRM length mismatch/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/control.test.ts
```
Expected: FAIL — no exported members `HandshakeMsgType` / `encodeProvision` / etc.

- [ ] **Step 3: Write minimal implementation** — append to `packages/relay-protocol/src/control.ts`:
```ts
/**
 * E2E handshake message discriminators. The leading byte of a handshake-message payload
 * carried inside an Opcode.HANDSHAKE (0x04) data-plane frame. Range 0x90..0x9F.
 */
export const HandshakeMsgType = {
  PROVISION: 0x90,
  EPHEMERAL: 0x91,
  KEY_CONFIRM: 0x92,
} as const;
export type HandshakeMsgType = (typeof HandshakeMsgType)[keyof typeof HandshakeMsgType];

const PUBKEY_LEN = 32;
const NONCE_LEN = 16;
const TAG_LEN = 32;
const CONFIRM_LEN = 32;

export interface ProvisionMessage {
  phonePub: Uint8Array;
  phoneNonce: Uint8Array;
  tag: Uint8Array;
}

export interface EphemeralMessage {
  ephemeralPub: Uint8Array;
  connNonce: Uint8Array;
}

export interface KeyConfirmMessage {
  confirm: Uint8Array;
}

export function peekHandshakeMsgType(bytes: Uint8Array): number {
  if (bytes.length < 1) throw new Error('empty handshake message');
  return bytes[0];
}

export function encodeProvision(msg: ProvisionMessage): Uint8Array {
  if (msg.phonePub.length !== PUBKEY_LEN) throw new Error('phonePub must be 32 bytes');
  if (msg.phoneNonce.length !== NONCE_LEN) throw new Error('phoneNonce must be 16 bytes');
  if (msg.tag.length !== TAG_LEN) throw new Error('tag must be 32 bytes');
  return concatBytes(
    new Uint8Array([HandshakeMsgType.PROVISION]),
    msg.phonePub,
    msg.phoneNonce,
    msg.tag,
  );
}

export function decodeProvision(bytes: Uint8Array): ProvisionMessage {
  if (bytes[0] !== HandshakeMsgType.PROVISION) throw new Error('not a PROVISION message');
  if (bytes.length !== 1 + PUBKEY_LEN + NONCE_LEN + TAG_LEN) {
    throw new Error('PROVISION length mismatch');
  }
  const phonePub = bytes.subarray(1, 1 + PUBKEY_LEN);
  const phoneNonce = bytes.subarray(1 + PUBKEY_LEN, 1 + PUBKEY_LEN + NONCE_LEN);
  const tag = bytes.subarray(1 + PUBKEY_LEN + NONCE_LEN, 1 + PUBKEY_LEN + NONCE_LEN + TAG_LEN);
  return { phonePub, phoneNonce, tag };
}

export function encodeEphemeral(msg: EphemeralMessage): Uint8Array {
  if (msg.ephemeralPub.length !== PUBKEY_LEN) throw new Error('ephemeralPub must be 32 bytes');
  if (msg.connNonce.length !== NONCE_LEN) throw new Error('connNonce must be 16 bytes');
  return concatBytes(new Uint8Array([HandshakeMsgType.EPHEMERAL]), msg.ephemeralPub, msg.connNonce);
}

export function decodeEphemeral(bytes: Uint8Array): EphemeralMessage {
  if (bytes[0] !== HandshakeMsgType.EPHEMERAL) throw new Error('not an EPHEMERAL message');
  if (bytes.length !== 1 + PUBKEY_LEN + NONCE_LEN) throw new Error('EPHEMERAL length mismatch');
  const ephemeralPub = bytes.subarray(1, 1 + PUBKEY_LEN);
  const connNonce = bytes.subarray(1 + PUBKEY_LEN, 1 + PUBKEY_LEN + NONCE_LEN);
  return { ephemeralPub, connNonce };
}

export function encodeKeyConfirm(msg: KeyConfirmMessage): Uint8Array {
  if (msg.confirm.length !== CONFIRM_LEN) throw new Error('confirm must be 32 bytes');
  return concatBytes(new Uint8Array([HandshakeMsgType.KEY_CONFIRM]), msg.confirm);
}

export function decodeKeyConfirm(bytes: Uint8Array): KeyConfirmMessage {
  if (bytes[0] !== HandshakeMsgType.KEY_CONFIRM) throw new Error('not a KEY_CONFIRM message');
  if (bytes.length !== 1 + CONFIRM_LEN) throw new Error('KEY_CONFIRM length mismatch');
  return { confirm: bytes.subarray(1, 1 + CONFIRM_LEN) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/control.test.ts
```
Expected: PASS — PROVISION/EPHEMERAL/KEY_CONFIRM round-trips, size validation, discriminator + length rejection all green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/control.ts packages/relay-protocol/src/control.test.ts
git commit -m "feat(relay-protocol): control-plane E2E handshake messages"
```

---

## Task 20: Public API barrel (data + control plane)

**Files:** Test `packages/relay-protocol/src/index.test.ts` (replace), Modify `packages/relay-protocol/src/index.ts`

- [ ] **Step 1: Write the failing test** — replace the contents of `packages/relay-protocol/src/index.test.ts`:
```ts
import * as api from './index.js';

describe('public API barrel', () => {
  it('exports the byte helpers', () => {
    for (const name of [
      'concatBytes',
      'bytesEqual',
      'writeUint16BE',
      'readUint16BE',
      'writeUint32BE',
      'readUint32BE',
      'writeUint64BE',
      'readUint64BE',
      'toBase64Url',
      'fromBase64Url',
      'utf8Encode',
      'utf8Decode',
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('exports the frame surface', () => {
    expect(api.PROTO_VER).toBe(1);
    expect(api.OUTER_HEADER_LEN).toBe(10);
    expect(api.INNER_HEADER_LEN).toBe(16);
    expect(api.MAX_FRAME_PAYLOAD).toBe(1024 * 1024);
    expect(api.MAX_REASSEMBLY).toBe(32 * 1024 * 1024);
    expect(api.Direction.GW_TO_PHONE).toBe(0x01);
    expect(api.Opcode.CHAT_START).toBe(0x10);
    expect(api.Opcode.HANDSHAKE).toBe(0x04);
    expect(typeof api.encodeInnerFrame).toBe('function');
    expect(typeof api.decodeInnerFrame).toBe('function');
    expect(typeof api.sealRecord).toBe('function');
    expect(typeof api.openRecord).toBe('function');
    expect(typeof api.splitChunks).toBe('function');
    expect(typeof api.RecordSeqGuard).toBe('function');
    expect(typeof api.ChunkReassembler).toBe('function');
  });

  it('exports the crypto helpers', () => {
    for (const name of [
      'generateX25519KeyPair',
      'rawToPublicKey',
      'rawToPrivateKey',
      'publicKeyToRaw',
      'privateKeyToRaw',
      'diffieHellmanRaw',
      'hkdfExtract',
      'hkdfExpand',
      'hmacSha256',
      'sha256',
      'aeadSeal',
      'aeadOpen',
      'counterNonce',
      'randomBytes32',
      'randomBytes16',
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('exports the handshake surface', () => {
    expect(api.SAS_DIGITS).toBe(6);
    expect(api.HANDSHAKE_LABELS.G2P).toBe('dash g2p key');
    expect(api.TRANSCRIPT_PREFIX).toBe('dash-v1');
    expect(typeof api.buildTranscript).toBe('function');
    expect(typeof api.deriveSessionKeys).toBe('function');
    expect(typeof api.computeSas).toBe('function');
    expect(typeof api.pairingProvisionTag).toBe('function');
    expect(typeof api.slotAuthProof).toBe('function');
    expect(typeof api.slotSecretCommitment).toBe('function');
  });

  it('exports the control-plane surface', () => {
    expect(api.ControlMsgType.JOIN).toBe(0x80);
    expect(api.Role.PHONE).toBe(0x02);
    expect(api.JoinResultCode.OK).toBe(0x00);
    expect(api.HandshakeMsgType.PROVISION).toBe(0x90);
    for (const name of [
      'peekControlMsgType',
      'encodeJoin',
      'decodeJoin',
      'encodeChallenge',
      'decodeChallenge',
      'encodeSlotAuth',
      'decodeSlotAuth',
      'encodeJoinResult',
      'decodeJoinResult',
      'peekHandshakeMsgType',
      'encodeProvision',
      'decodeProvision',
      'encodeEphemeral',
      'decodeEphemeral',
      'encodeKeyConfirm',
      'decodeKeyConfirm',
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/index.test.ts
```
Expected: FAIL — `api.PROTO_VER` is `undefined` (index.ts currently only `export {}`).

- [ ] **Step 3: Write minimal implementation** — replace the contents of `packages/relay-protocol/src/index.ts`:
```ts
export {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  readUint16BE,
  readUint32BE,
  readUint64BE,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  writeUint16BE,
  writeUint32BE,
  writeUint64BE,
} from './bytes.js';
export {
  AEAD_NONCE_LEN,
  AEAD_TAG_LEN,
  ChunkReassembler,
  decodeInnerFrame,
  Direction,
  encodeInnerFrame,
  FrameFlags,
  INNER_HEADER_LEN,
  INNER_VER,
  MAX_FRAME_PAYLOAD,
  MAX_REASSEMBLY,
  MAX_WS_MESSAGE,
  Opcode,
  openRecord,
  OUTER_HEADER_LEN,
  PROTO_VER,
  RecordSeqGuard,
  sealRecord,
  splitChunks,
} from './frame.js';
export type { InnerFrame, OuterHeader, SealedRecord } from './frame.js';
export {
  aeadOpen,
  aeadSeal,
  counterNonce,
  diffieHellmanRaw,
  generateX25519KeyPair,
  hkdfExpand,
  hkdfExtract,
  hmacSha256,
  privateKeyToRaw,
  publicKeyToRaw,
  randomBytes16,
  randomBytes32,
  rawToPrivateKey,
  rawToPublicKey,
  sha256,
} from './crypto.js';
export type { X25519KeyPairRaw } from './crypto.js';
export {
  buildTranscript,
  computeSas,
  deriveSessionKeys,
  HANDSHAKE_LABELS,
  pairingProvisionTag,
  PROVISION_PREFIX,
  SAS_DIGITS,
  slotAuthProof,
  slotSecretCommitment,
  SLOT_AUTH_PREFIX,
  TRANSCRIPT_PREFIX,
} from './handshake.js';
export type { HandshakeInputs, SessionKeys } from './handshake.js';
export {
  ControlMsgType,
  decodeChallenge,
  decodeEphemeral,
  decodeJoin,
  decodeJoinResult,
  decodeKeyConfirm,
  decodeProvision,
  decodeSlotAuth,
  encodeChallenge,
  encodeEphemeral,
  encodeJoin,
  encodeJoinResult,
  encodeKeyConfirm,
  encodeProvision,
  encodeSlotAuth,
  HandshakeMsgType,
  JoinResultCode,
  peekControlMsgType,
  peekHandshakeMsgType,
  Role,
} from './control.js';
export type {
  EphemeralMessage,
  JoinMessage,
  JoinResultMessage,
  KeyConfirmMessage,
  ProvisionMessage,
  SlotAuthMessage,
} from './control.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run packages/relay-protocol/src/index.test.ts
```
Expected: PASS — all five export groups present.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/index.ts packages/relay-protocol/src/index.test.ts
git commit -m "feat(relay-protocol): public API barrel (data + control plane)"
```

---

## Task 21: Generate and freeze the cross-runtime crypto test vector

**Files:** Create `packages/relay-protocol/scripts/gen-vector.mts`, Create `packages/relay-protocol/src/vectors.ts`

This task produces fixed, deterministic test-vector values by running the just-built helpers against hard-coded inputs, then **freezes the outputs into a checked-in constant**. The Kotlin client (Phase 2) asserts against the identical hex values, so this is the single source of truth for cross-runtime parity. We use **fixed hex inputs** (not random) for everything except the X25519 keypairs, which are generated once and frozen at this moment.

The script lives in `scripts/` (outside `src/`), so it is not part of the tsup `entry` and not type-checked by the `src` tsconfig include. It imports from the built `dist`, so build first.

- [ ] **Step 1: Write the generator script**

Create `packages/relay-protocol/scripts/gen-vector.mts`:
```ts
// Run with: npm run build -w packages/relay-protocol && npx tsx packages/relay-protocol/scripts/gen-vector.mts
// Prints a CryptoVector literal to paste into src/vectors.ts. Inputs are fixed (reproducible),
// except the X25519 alice/bob keypairs which are generated once and frozen by this run.
import { Buffer } from 'node:buffer';
import {
  aeadSeal,
  buildTranscript,
  deriveSessionKeys,
  diffieHellmanRaw,
  generateX25519KeyPair,
  hkdfExpand,
  hkdfExtract,
  pairingProvisionTag,
  sha256,
  slotAuthProof,
  slotSecretCommitment,
} from '../dist/index.js';

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

// --- X25519 (frozen once at this run)
const alice = generateX25519KeyPair();
const bob = generateX25519KeyPair();
const sharedSecret = diffieHellmanRaw(alice.privateKey, bob.publicKey);

// --- HKDF (fixed inputs)
const hkdfSalt = fromHex('02'.repeat(32));
const hkdfIkm = fromHex('01'.repeat(32));
const hkdfInfo = 'dash g2p key';
const hkdfPrk = hkdfExtract(hkdfSalt, hkdfIkm);
const hkdfOkm = hkdfExpand(hkdfPrk, new TextEncoder().encode(hkdfInfo), 32);

// --- AEAD (fixed inputs)
const aeadKey = fromHex('07'.repeat(32));
const aeadNonce = fromHex('000000000000000000000001');
const aeadAad = fromHex('0102030405060708090a');
const aeadPlaintext = 'dash-vector';
const aeadSealed = aeadSeal(aeadKey, aeadNonce, aeadAad, new TextEncoder().encode(aeadPlaintext));

// --- Handshake (fixed inputs, psk present)
const hsLinkId = 'a4u-r_vZhRw5yqV0hY4LL1I4zNmpwGDi';
const hsGwStaticPub = fromHex('11'.repeat(32));
const hsPhoneStaticPub = fromHex('22'.repeat(32));
const hsGwEphemeralPub = fromHex('33'.repeat(32));
const hsPhoneEphemeralPub = fromHex('44'.repeat(32));
const hsGwNonce = fromHex('55'.repeat(16));
const hsPhoneNonce = fromHex('66'.repeat(16));
const hsSsEe = fromHex('a1'.repeat(32));
const hsSsSe = fromHex('b2'.repeat(32));
const hsSsEs = fromHex('c3'.repeat(32));
const hsPsk = fromHex('d4'.repeat(32));
const transcript = buildTranscript({
  linkId: hsLinkId,
  gwStaticPub: hsGwStaticPub,
  phoneStaticPub: hsPhoneStaticPub,
  gwEphemeralPub: hsGwEphemeralPub,
  phoneEphemeralPub: hsPhoneEphemeralPub,
  gwNonce: hsGwNonce,
  phoneNonce: hsPhoneNonce,
});
const keys = deriveSessionKeys({ ssEe: hsSsEe, ssSe: hsSsSe, ssEs: hsSsEs, transcript, psk: hsPsk });

// --- Control-plane crypto constructions (fixed inputs)
const provTag = pairingProvisionTag({
  psk: hsPsk,
  linkId: hsLinkId,
  gwStaticPub: hsGwStaticPub,
  phoneStaticPub: hsPhoneStaticPub,
  phoneNonce: hsPhoneNonce,
});
const slotSecret = fromHex('7e'.repeat(32));
const slotChallenge = fromHex('42'.repeat(16));
const slotHash = slotSecretCommitment(slotSecret);
const slotProof = slotAuthProof(slotSecret, slotChallenge);

const vector = {
  alicePrivHex: hex(alice.privateKey),
  alicePubHex: hex(alice.publicKey),
  bobPrivHex: hex(bob.privateKey),
  bobPubHex: hex(bob.publicKey),
  sharedSecretHex: hex(sharedSecret),
  hkdfSaltHex: hex(hkdfSalt),
  hkdfIkmHex: hex(hkdfIkm),
  hkdfInfoUtf8: hkdfInfo,
  hkdfPrkHex: hex(hkdfPrk),
  hkdfOkmHex: hex(hkdfOkm),
  aeadKeyHex: hex(aeadKey),
  aeadNonceHex: hex(aeadNonce),
  aeadAadHex: hex(aeadAad),
  aeadPlaintextUtf8: aeadPlaintext,
  aeadSealedHex: hex(aeadSealed),
  hsLinkId,
  hsGwStaticPubHex: hex(hsGwStaticPub),
  hsPhoneStaticPubHex: hex(hsPhoneStaticPub),
  hsGwEphemeralPubHex: hex(hsGwEphemeralPub),
  hsPhoneEphemeralPubHex: hex(hsPhoneEphemeralPub),
  hsGwNonceHex: hex(hsGwNonce),
  hsPhoneNonceHex: hex(hsPhoneNonce),
  hsSsEeHex: hex(hsSsEe),
  hsSsSeHex: hex(hsSsSe),
  hsSsEsHex: hex(hsSsEs),
  hsPskHex: hex(hsPsk),
  hsTranscriptSha256Hex: hex(sha256(transcript)),
  hsPrkHex: hex(keys.prk),
  hsKg2pHex: hex(keys.kG2p),
  hsKp2gHex: hex(keys.kP2g),
  hsCfmGHex: hex(keys.cfmG),
  hsCfmPHex: hex(keys.cfmP),
  hsSas: keys.sas,
  provTagHex: hex(provTag),
  slotSecretHex: hex(slotSecret),
  slotChallengeHex: hex(slotChallenge),
  slotSecretHashHex: hex(slotHash),
  slotProofHex: hex(slotProof),
};
console.log(JSON.stringify(vector, null, 2));
```

- [ ] **Step 2: Run the generator and capture the output**

Run:
```
npm run build -w packages/relay-protocol && npx tsx packages/relay-protocol/scripts/gen-vector.mts
```
Expected: prints a JSON object with all hex fields populated (every `*Hex` is even-length and non-empty; `hsSas` is 6 digits). Copy this JSON for Step 3.

- [ ] **Step 3: Write the checked-in vector module**

Create `packages/relay-protocol/src/vectors.ts`. **Paste the JSON values from Step 2 into the literal below**, replacing every `<<paste from generator>>`. The non-placeholder hex values shown for the *fixed* inputs (`hkdfSaltHex`, `hkdfIkmHex`, `aeadKeyHex`, etc.) MUST match the generator output exactly — the generator prints them too; cross-check. Only `alice*`/`bob*`/`sharedSecret*` vary per generation and are frozen now.
```ts
export interface CryptoVector {
  alicePrivHex: string;
  alicePubHex: string;
  bobPrivHex: string;
  bobPubHex: string;
  sharedSecretHex: string;
  hkdfSaltHex: string;
  hkdfIkmHex: string;
  hkdfInfoUtf8: string;
  hkdfPrkHex: string;
  hkdfOkmHex: string;
  aeadKeyHex: string;
  aeadNonceHex: string;
  aeadAadHex: string;
  aeadPlaintextUtf8: string;
  aeadSealedHex: string;
  hsLinkId: string;
  hsGwStaticPubHex: string;
  hsPhoneStaticPubHex: string;
  hsGwEphemeralPubHex: string;
  hsPhoneEphemeralPubHex: string;
  hsGwNonceHex: string;
  hsPhoneNonceHex: string;
  hsSsEeHex: string;
  hsSsSeHex: string;
  hsSsEsHex: string;
  hsPskHex: string;
  hsTranscriptSha256Hex: string;
  hsPrkHex: string;
  hsKg2pHex: string;
  hsKp2gHex: string;
  hsCfmGHex: string;
  hsCfmPHex: string;
  hsSas: string;
  provTagHex: string;
  slotSecretHex: string;
  slotChallengeHex: string;
  slotSecretHashHex: string;
  slotProofHex: string;
}

// Frozen cross-runtime test vector. The Kotlin client (Phase 2) MUST reproduce every value.
// Regenerate ONLY via scripts/gen-vector.mts; never edit by hand.
export const CRYPTO_VECTOR: CryptoVector = {
  alicePrivHex: '<<paste from generator>>',
  alicePubHex: '<<paste from generator>>',
  bobPrivHex: '<<paste from generator>>',
  bobPubHex: '<<paste from generator>>',
  sharedSecretHex: '<<paste from generator>>',
  hkdfSaltHex: '0202020202020202020202020202020202020202020202020202020202020202',
  hkdfIkmHex: '0101010101010101010101010101010101010101010101010101010101010101',
  hkdfInfoUtf8: 'dash g2p key',
  hkdfPrkHex: '<<paste from generator>>',
  hkdfOkmHex: '<<paste from generator>>',
  aeadKeyHex: '0707070707070707070707070707070707070707070707070707070707070707',
  aeadNonceHex: '000000000000000000000001',
  aeadAadHex: '0102030405060708090a',
  aeadPlaintextUtf8: 'dash-vector',
  aeadSealedHex: '<<paste from generator>>',
  hsLinkId: 'a4u-r_vZhRw5yqV0hY4LL1I4zNmpwGDi',
  hsGwStaticPubHex: '1111111111111111111111111111111111111111111111111111111111111111',
  hsPhoneStaticPubHex: '2222222222222222222222222222222222222222222222222222222222222222',
  hsGwEphemeralPubHex: '3333333333333333333333333333333333333333333333333333333333333333',
  hsPhoneEphemeralPubHex: '4444444444444444444444444444444444444444444444444444444444444444',
  hsGwNonceHex: '55555555555555555555555555555555',
  hsPhoneNonceHex: '66666666666666666666666666666666',
  hsSsEeHex: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  hsSsSeHex: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  hsSsEsHex: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
  hsPskHex: 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4',
  hsTranscriptSha256Hex: '<<paste from generator>>',
  hsPrkHex: '<<paste from generator>>',
  hsKg2pHex: '<<paste from generator>>',
  hsKp2gHex: '<<paste from generator>>',
  hsCfmGHex: '<<paste from generator>>',
  hsCfmPHex: '<<paste from generator>>',
  hsSas: '<<paste from generator>>',
  provTagHex: '<<paste from generator>>',
  slotSecretHex: '7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e',
  slotChallengeHex: '42424242424242424242424242424242',
  slotSecretHashHex: '<<paste from generator>>',
  slotProofHex: '<<paste from generator>>',
};
```
**IMPORTANT:** Replace every `<<paste from generator>>`. Do not leave any `<<...>>` token — Task 22's first test fails loudly if you do. Note the 32-byte repeated-byte fields above (`hsSsEe`, etc.) are 64 hex chars; the generator output is authoritative if a hand-typed value disagrees.

- [ ] **Step 4: Format only (the verifying test is Task 22)**

Run:
```
npm run lint:fix
```
Expected: exit 0; `vectors.ts` reformatted to Biome style (no functional change).

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/scripts/gen-vector.mts packages/relay-protocol/src/vectors.ts
git commit -m "feat(relay-protocol): generate and freeze cross-runtime crypto vector"
```

---

## Task 22: Cross-runtime vector test (re-derives every value from frozen inputs)

**Files:** Test `packages/relay-protocol/src/vectors.test.ts`, Modify `packages/relay-protocol/src/index.ts`

This is the parity gate: re-run every helper against the frozen inputs in `CRYPTO_VECTOR` and assert the helper output equals the frozen output. If a future code change alters any crypto output, this fails — signaling the Kotlin mirror would diverge.

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/vectors.test.ts`:
```ts
import { Buffer } from 'node:buffer';
import {
  aeadOpen,
  aeadSeal,
  buildTranscript,
  computeSas,
  deriveSessionKeys,
  diffieHellmanRaw,
  hkdfExpand,
  hkdfExtract,
  pairingProvisionTag,
  sha256,
  slotAuthProof,
  slotSecretCommitment,
} from './index.js';
import { CRYPTO_VECTOR as V } from './vectors.js';

const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');

describe('cross-runtime crypto vector', () => {
  it('has no unreplaced placeholders', () => {
    for (const value of Object.values(V)) {
      expect(String(value)).not.toContain('<<');
    }
  });

  it('X25519: DH(alicePriv,bobPub) == DH(bobPriv,alicePub) == frozen shared secret', () => {
    const a = diffieHellmanRaw(fromHex(V.alicePrivHex), fromHex(V.bobPubHex));
    const b = diffieHellmanRaw(fromHex(V.bobPrivHex), fromHex(V.alicePubHex));
    expect(hex(a)).toBe(V.sharedSecretHex);
    expect(hex(b)).toBe(V.sharedSecretHex);
  });

  it('HKDF: extract+expand reproduce the frozen PRK and OKM', () => {
    const prk = hkdfExtract(fromHex(V.hkdfSaltHex), fromHex(V.hkdfIkmHex));
    expect(hex(prk)).toBe(V.hkdfPrkHex);
    const okm = hkdfExpand(prk, new TextEncoder().encode(V.hkdfInfoUtf8), 32);
    expect(hex(okm)).toBe(V.hkdfOkmHex);
  });

  it('AEAD: seal reproduces the frozen ciphertext+tag and opens back', () => {
    const sealed = aeadSeal(
      fromHex(V.aeadKeyHex),
      fromHex(V.aeadNonceHex),
      fromHex(V.aeadAadHex),
      new TextEncoder().encode(V.aeadPlaintextUtf8),
    );
    expect(hex(sealed)).toBe(V.aeadSealedHex);
    const opened = aeadOpen(
      fromHex(V.aeadKeyHex),
      fromHex(V.aeadNonceHex),
      fromHex(V.aeadAadHex),
      fromHex(V.aeadSealedHex),
    );
    expect(new TextDecoder().decode(opened)).toBe(V.aeadPlaintextUtf8);
  });

  it('Handshake: transcript salt, PRK, directional keys, confirmations, SAS all match', () => {
    const transcript = buildTranscript({
      linkId: V.hsLinkId,
      gwStaticPub: fromHex(V.hsGwStaticPubHex),
      phoneStaticPub: fromHex(V.hsPhoneStaticPubHex),
      gwEphemeralPub: fromHex(V.hsGwEphemeralPubHex),
      phoneEphemeralPub: fromHex(V.hsPhoneEphemeralPubHex),
      gwNonce: fromHex(V.hsGwNonceHex),
      phoneNonce: fromHex(V.hsPhoneNonceHex),
    });
    expect(hex(sha256(transcript))).toBe(V.hsTranscriptSha256Hex);

    const keys = deriveSessionKeys({
      ssEe: fromHex(V.hsSsEeHex),
      ssSe: fromHex(V.hsSsSeHex),
      ssEs: fromHex(V.hsSsEsHex),
      transcript,
      psk: fromHex(V.hsPskHex),
    });
    expect(hex(keys.prk)).toBe(V.hsPrkHex);
    expect(hex(keys.kG2p)).toBe(V.hsKg2pHex);
    expect(hex(keys.kP2g)).toBe(V.hsKp2gHex);
    expect(hex(keys.cfmG)).toBe(V.hsCfmGHex);
    expect(hex(keys.cfmP)).toBe(V.hsCfmPHex);
    expect(keys.sas).toBe(V.hsSas);
    expect(computeSas(keys.prk)).toBe(V.hsSas);
  });

  it('Control plane: provisioning tag, slot-secret commitment, and slot-auth proof all match', () => {
    const tag = pairingProvisionTag({
      psk: fromHex(V.hsPskHex),
      linkId: V.hsLinkId,
      gwStaticPub: fromHex(V.hsGwStaticPubHex),
      phoneStaticPub: fromHex(V.hsPhoneStaticPubHex),
      phoneNonce: fromHex(V.hsPhoneNonceHex),
    });
    expect(hex(tag)).toBe(V.provTagHex);
    expect(hex(slotSecretCommitment(fromHex(V.slotSecretHex)))).toBe(V.slotSecretHashHex);
    expect(hex(slotAuthProof(fromHex(V.slotSecretHex), fromHex(V.slotChallengeHex)))).toBe(
      V.slotProofHex,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes if Task 21 was done right)**

This test imports `CRYPTO_VECTOR` directly from `./vectors.js` (which exists from Task 21), so it is runnable now. Run:
```
npx vitest run packages/relay-protocol/src/vectors.test.ts
```
Expected: **PASS** if you correctly pasted the generator output in Task 21. If it FAILS with "has no unreplaced placeholders" or a hex mismatch, you left a `<<paste>>` token or mistyped a value — re-run `npx tsx packages/relay-protocol/scripts/gen-vector.mts` and fix `vectors.ts` (the X25519 alice/bob/shared values must come from the SAME generator run).

- [ ] **Step 3: Add the vector to the public API barrel** — append to `packages/relay-protocol/src/index.ts`:
```ts
export { CRYPTO_VECTOR } from './vectors.js';
export type { CryptoVector } from './vectors.js';
```

- [ ] **Step 4: Run the full package suite to verify everything passes**

Run:
```
npx vitest run packages/relay-protocol
```
Expected: PASS — every test file (`bytes`, `crypto`, `frame`, `handshake`, `control`, `index`, `vectors`) green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/vectors.test.ts packages/relay-protocol/src/index.ts
git commit -m "test(relay-protocol): cross-runtime crypto vector parity gate"
```

---

## Task 23: End-to-end wire round-trip integration test

**Files:** Test `packages/relay-protocol/src/integration.test.ts`

This wires the whole stack together exactly as Units C/D will use it: a derived directional key seals a chunked logical message into a sequence of WS binary records with monotonic `recordSeq`; the peer opens, verifies monotonicity, decodes inner frames, and reassembles the original payload. It is the dress rehearsal for the acceptance harness and a guard against any cross-module mismatch.

- [ ] **Step 1: Write the failing test**

Create `packages/relay-protocol/src/integration.test.ts`:
```ts
import {
  ChunkReassembler,
  decodeInnerFrame,
  Direction,
  encodeInnerFrame,
  MAX_FRAME_PAYLOAD,
  Opcode,
  openRecord,
  PROTO_VER,
  RecordSeqGuard,
  sealRecord,
  splitChunks,
} from './index.js';

describe('end-to-end wire round-trip', () => {
  it('seals a chunked message into monotonic records and reassembles on the peer', () => {
    const key = new Uint8Array(32).fill(0x42); // stands in for a derived k_g2p
    const direction = Direction.GW_TO_PHONE;
    const streamId = 2; // gateway-initiated => even
    const original = new Uint8Array(MAX_FRAME_PAYLOAD * 2 + 7);
    for (let i = 0; i < original.length; i += 1) original[i] = i % 251;

    // SENDER: split -> encode inner -> seal outer with increasing recordSeq
    const innerFrames = splitChunks(Opcode.RESP, streamId, original);
    expect(innerFrames.length).toBe(3);
    const wsMessages: Uint8Array[] = [];
    let seq = 0n;
    for (const f of innerFrames) {
      const sealed = sealRecord(
        key,
        { protoVer: PROTO_VER, direction, recordSeq: seq },
        encodeInnerFrame(f),
      );
      wsMessages.push(sealed.bytes);
      seq += 1n;
    }

    // RECEIVER: open -> guard monotonicity -> decode inner -> reassemble
    const guard = new RecordSeqGuard();
    const reasm = new ChunkReassembler();
    let result: Uint8Array | null = null;
    for (const msg of wsMessages) {
      const { header, innerFrameBytes } = openRecord(key, msg, direction);
      expect(guard.accept(header.recordSeq)).toBe(true);
      const inner = decodeInnerFrame(innerFrameBytes);
      const out = reasm.push(inner);
      if (out !== null) result = out;
    }

    expect(result).not.toBeNull();
    expect((result as Uint8Array).length).toBe(original.length);
    expect([...(result as Uint8Array)]).toEqual([...original]);
  });

  it('rejects a replayed record at the monotonicity guard', () => {
    const key = new Uint8Array(32).fill(0x42);
    const direction = Direction.PHONE_TO_GW;
    const inner = encodeInnerFrame({
      ver: 1,
      type: Opcode.CHAT_EVENT,
      flags: 0b01,
      streamId: 1,
      chunkIndex: 0,
      payload: new TextEncoder().encode('{"seq":1}'),
    });
    const msg = sealRecord(key, { protoVer: PROTO_VER, direction, recordSeq: 0n }, inner).bytes;
    const guard = new RecordSeqGuard();
    const first = openRecord(key, msg, direction);
    expect(guard.accept(first.header.recordSeq)).toBe(true);
    // replay the same ws message
    const replay = openRecord(key, msg, direction);
    expect(guard.accept(replay.header.recordSeq)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run packages/relay-protocol/src/integration.test.ts
```
Expected: FAIL only if a wiring bug exists; if all prior tasks are correct this PASSES on first run. (TDD note: this is an integration assembly of already-tested units; treat a RED here as a real cross-module bug to fix in `frame.ts`/`crypto.ts`, not a missing export.)

- [ ] **Step 3: (No new implementation expected.)** If Step 2 was RED, debug the offending module per the error and re-run until GREEN. If it was already GREEN, proceed.

- [ ] **Step 4: Run the full package suite**

Run:
```
npx vitest run packages/relay-protocol
```
Expected: PASS — all seven test files green.

- [ ] **Step 5: Commit**
```
git add packages/relay-protocol/src/integration.test.ts
git commit -m "test(relay-protocol): end-to-end wire round-trip integration"
```

---

## Task 24: Final gate — lint, typecheck, build, full test suite

**Files:** (no new files; verification + a final commit if anything needed formatting)

This task verifies the package satisfies every repo gate before it is consumed by Units B/C/D.

- [ ] **Step 1: Lint the package and the repo**

Run:
```
npm run lint
```
Expected: Biome exits 0 (no `any`, single quotes, semicolons, 100-col). If it reports fixable issues, run `npm run lint:fix`, re-run `npm run lint`, and `git add` only the relay-protocol files that changed.

- [ ] **Step 2: Typecheck via build**

Run:
```
npm run build -w packages/relay-protocol
```
Expected: tsup writes `dist/index.js` and `dist/index.d.ts`, exit 0. Confirm `dist/index.d.ts` contains the control-plane exports:
```
grep -E 'encodeJoin|encodeProvision|JoinResultCode|HandshakeMsgType|slotAuthProof' packages/relay-protocol/dist/index.d.ts
```
Expected: matches printed (the frozen control-plane surface is in the published types).

- [ ] **Step 3: Run the full repo test suite to confirm no regressions**

Run:
```
npx vitest run packages/relay-protocol
```
Expected: PASS — `bytes`, `crypto`, `frame`, `handshake`, `control`, `index`, `vectors`, `integration` all green.

Then confirm the package participates in the root build chain:
```
npm run build
```
Expected: the relay-protocol build runs first (it has no internal deps) and the whole repo builds with exit 0.

- [ ] **Step 4: Verify the contract is importable by name** (smoke-check that downstream `@dash/relay-protocol` imports will resolve)

Run:
```
node --input-type=module -e "import('@dash/relay-protocol').then((m) => { if (m.Opcode.HANDSHAKE !== 0x04) throw new Error('bad Opcode'); if (m.ControlMsgType.JOIN !== 0x80) throw new Error('bad ControlMsgType'); if (typeof m.encodeProvision !== 'function') throw new Error('missing encodeProvision'); console.log('relay-protocol contract OK'); })"
```
Expected: prints `relay-protocol contract OK`. (If the bare-specifier import fails, run `npm install` to re-link the workspace, then retry.)

- [ ] **Step 5: Commit (only if Step 1 reformatted anything; otherwise skip)**
```
git add packages/relay-protocol/src
git commit -m "chore(relay-protocol): final lint/format pass"
```

---

## Done criteria

- `npx vitest run packages/relay-protocol` is fully green across all eight test files.
- `npm run lint` and `npm run build` pass with the package included.
- `packages/relay-protocol/dist/index.d.ts` exports the full frozen contract — **data plane** (bytes, crypto, frame codec, handshake derivation) **and control plane** (relay-join messages, E2E handshake messages) — verbatim as listed in the barrel.
- `CRYPTO_VECTOR` is frozen with no `<<...>>` placeholders, and the parity test re-derives every value (including the control-plane `provTag`, `slotSecretHash`, `slotProof`).
- Units B (relay DO), C (gateway tunnel-client), and D (CLI harness) import `@dash/relay-protocol` and use these exact `encode*`/`decode*` helpers — **no unit reinvents signaling**.
