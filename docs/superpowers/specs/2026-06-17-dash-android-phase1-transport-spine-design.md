# Dash Android App — Phase 1: Secure Transport Spine

**Date:** 2026-06-17
**Parent:** [Dash Android App — Umbrella Design](./2026-06-17-dash-android-app-design.md)
**Status:** Design approved (decisions locked); ready for implementation planning.

## Purpose

Phase 1 builds the **secure transport spine** that lets a remote client reach the loopback-bound Dash gateway through a zero-knowledge cloud relay. It is the foundation every later phase depends on, and its wire contract (handshake + frame format) is frozen here so the Android app (Phase 2) and management UI (Phase 3) build against a known-good tunnel.

**Done =** a TypeScript CLI test client pairs by QR (with SAS confirmation) and round-trips **a real chat turn** *and* **a real `GET /agents` management call** through the encrypted relay; a forced reconnect transparently re-handshakes and resumes the chat via `seq`/event-replay.

This design was hardened by an adversarial review (three independent attacker lenses). The findings and fixes are recorded in [Threat model](#threat-model--adversarial-findings).

## Decisions (locked)

1. **Crypto construction** — hand-rolled **X25519 + HKDF-SHA256 + IETF ChaCha20-Poly1305** on Node 22 built-ins (zero gateway crypto deps) + lazysodium on Kotlin. *(XChaCha rejected — not a Node built-in. Noise `XKpsk3` remains a drop-in future swap: identical wire cipher.)*
2. **Relay operating model** — a **single Dash-hosted shared relay** (one Cloudflare Worker + Durable Object on a Dash account, custom domain, dev/prod environments). `relayUrl` is overridable for self-host. Zero-knowledge ⇒ shared hosting is privacy-defensible.
3. **Pairing** — **mandatory human SAS confirmation** on the desktop before a phone's key is authorized.

Baked-in security non-negotiables (from the adversarial review, not optional):

4. **Fresh mutually-authenticated handshake on every connection (incl. reconnect); no E2E session-key persistence.**
5. **`slotSecret` is separate from the pairing secret;** relay slot-auth is a single-use challenge-response anti-DoS hint that never authorizes the E2E peer.
6. **One canonical frame/cipher spec;** direction authenticated in AAD; 64-bit per-direction counter nonce that resets to 0 *only* because every connection has a fresh key.
7. **`PENDING_TTL = 75 s`;** pairing secret 256-bit, single-use, wiped on every exit path.

## Components

1. **`apps/relay`** — Cloudflare Worker (stateless upgrade/auth shim) + one `RelayLink` Durable Object per `linkId`. Pipes opaque ciphertext between two inbound clients; hibernation-enabled; never sees plaintext, token, or secrets.
2. **`apps/gateway/src/tunnel-client.ts`** (new) — dials out to the relay, runs the E2E handshake state machine, bridges decrypted frames to the loopback chat WS (`:9200`) and management API (`:9300`), injecting the bearer token locally only.
3. **`packages/relay-protocol`** (new, TS) — frame types, opcode constants, handshake message shapes, crypto helpers, and the **cross-runtime test vector** — the single source of truth mirrored into Kotlin in Phase 2.
4. **`mc-cli pair`** (new command) — triggers pairing, prints an ASCII QR, displays the SAS for the user to confirm. *(The polished Mission Control "Link a phone" screen is Phase 4.)*
5. **TS CLI test client** — exercises the full chain end-to-end (the Phase 1 acceptance harness; stands in for the Android app).

## Crypto spine

### Primitives (canonical, one choice)

- **DH:** X25519. Node `crypto.generateKeyPairSync('x25519')` + `crypto.diffieHellman()`; Kotlin lazysodium `crypto_scalarmult`.
- **KDF:** HKDF-SHA256. Node `crypto.hkdfSync('sha256', …)`; Kotlin lazysodium.
- **AEAD:** **IETF ChaCha20-Poly1305**, 96-bit nonce = `[4B zero][8B BE counter]`. Node `crypto.createCipheriv('chacha20-poly1305', key, nonce, {authTagLength:16})`; Kotlin `crypto_aead_chacha20poly1305_ietf` (the IETF variant — not the 64-bit-nonce one).
- **MAC / SAS:** HMAC-SHA256.
- A **checked-in cross-runtime test vector** (fixed keys+nonce+plaintext → ciphertext+tag; fixed HKDF transcript → keys) is REQUIRED in both the TS package and the Kotlin client. This is the single highest implementation risk; lock it before Phase 2.

### Key roles

- **Static keys (long-lived, authenticate only):** gateway `S_g`, phone `S_p`. At rest: gateway encrypted credential store; phone hardware-backed Android Keystore (non-exportable). Never the sole input to a session key.
- **Ephemeral keys (per-connection, give forward secrecy):** `E_g`, `E_p` — fresh every connection, wiped immediately after derivation.
- **`pairingSecret` (`psk`):** 32 CSPRNG bytes, in the QR only, single-use, consumed atomically at the gateway on first authorized pairing, wiped on success and reject/timeout.
- **`slotSecret`:** a separate 32-CSPRNG-byte per-device secret generated at pairing, persisted on the phone, used only to answer the relay's slot-claim challenge. Not derived from `psk`; never authorizes the E2E peer.

### A. Pairing (first time, QR-bootstrapped)

1. **Gateway creates link.** `linkId` (192-bit CSPRNG → 32 base64url chars), `psk` (32B). Opens persistent WSS to the relay, sends `{type:'create', linkId, gwSlotAuthHash}`. DO writes `state:'pending'`, arms `PENDING_TTL` (75 s). Renders QR.
2. **QR (out-of-band; the relay never sees it):** `{ v:1, relayUrl, linkId, gatewayStaticPub: S_g.pub, psk }` (~130 bytes). Regenerated on every render, expires on screen blur/lock, never logged.
3. **Phone scans.** Generates `S_p` (in Keystore) and a fresh `slotSecret`.
4. **Phone connects** `…/connect?linkId=…&role=phone` (no secret in URL). DO replies with a random 16-byte `challenge`.
5. **Phone proves slot claim:** sends `slotProof = HMAC(slotSecret, challenge)` + commitment `slotSecretHash = sha256(slotSecret)`. DO accepts phone into the phone slot (anti-DoS only), `state:'paired-pending-confirm'`, cancels `PENDING_TTL`, notifies the gateway. On reconnect the DO re-challenges — a captured URL is not replayable.
6. **Provisioning message** (E2E-opaque to relay): `phonePub=S_p.pub`, fresh `phoneNonce` (16B), `tag = HMAC(psk, "dash-pair-v1" ‖ linkId ‖ S_g.pub ‖ S_p.pub ‖ phoneNonce)`. Gateway verifies `tag` before proceeding — a relay that swapped `S_p.pub` can't forge it (no `psk`).
7. **Authenticated ECDH** (both generate fresh `E_g`/`E_p`, exchange pubkeys + fresh 16-byte `gwNonce`/`phNonce`):
   ```
   ss_ee = X25519(E_self_priv, E_peer_pub)     // forward secrecy
   ss_se = X25519(S_self_priv, E_peer_pub)     // authentication
   ss_es = X25519(E_self_priv, S_peer_pub)
   IKM   = ss_ee || ss_se || ss_es             // canonical (gateway-perspective) ordering; both sides build identical IKM
   transcript = "dash-v1" || linkId || S_g.pub || S_p.pub || E_g.pub || E_p.pub || gwNonce || phNonce
   salt  = SHA-256(transcript)                 // binds statics, ephemerals, per-conn nonces
   PRK   = HKDF-Extract(salt, IKM || psk)      // psk folded in (PAIRING ONLY)
   k_g2p = HKDF-Expand(PRK, "dash g2p key", 32)
   k_p2g = HKDF-Expand(PRK, "dash p2g key", 32)
   cfm_g = HKDF-Expand(PRK, "dash confirm g", 32)
   cfm_p = HKDF-Expand(PRK, "dash confirm p", 32)
   sas   = base10(HMAC(PRK, "dash-sas")) truncated to 6 digits
   ```
8. **Mutual key confirmation (MUST, before authorization).** Gateway sends `AEAD(k_g2p, nonce=0, ad=header, cfm_g)`; phone sends `AEAD(k_p2g, nonce=0, ad=header, cfm_p)`. Each verifies the peer's; a half-open/replayed handshake fails here.
9. **SAS human confirmation (MUST).** Desktop and phone both display the 6-digit `sas`. **The gateway MUST NOT commit `S_p.pub` until the desktop user confirms the SAS matches.** A race-winning attacker (photographed QR) derives a *different* `sas` → mismatch → user rejects.
10. **Commit.** On confirm, gateway atomically: (a) marks `psk` consumed (refuses any second/different static key under this `linkId`; a new pairing needs a new QR); (b) inserts `{deviceId, S_p.pub, slotSecretHash, label, linkId, createdAt}` into the authorized-device table; (c) wipes `psk` + ephemerals. Phone persists `{linkId, relayUrl, S_g.pub, slotSecret, S_p in Keystore}`.

### B. Per-session (every connect *and* reconnect — identical, no key persistence)

Every new WebSocket re-runs the full fresh-ephemeral handshake (steps 7–8) **minus** QR/psk/SAS:

- `PRK = HKDF-Extract(salt, IKM)` — `psk` omitted (it's gone); authentication rests on the static-DH terms (`ss_se`, `ss_es`) proving each side holds its registered static private key.
- Gateway authorizes the session only if the recovered `S_p.pub` is in the authorized-device table **and** key-confirmation succeeds. Relay slot-auth never authorizes.
- Fresh ephemerals ⇒ fresh keys ⇒ the per-direction counter resets to 0 **safely** (a reset counter never meets a reused key — this is what structurally kills the relay-forced nonce-reuse attack).
- Encrypt-side invariant: refuse to emit a frame unless the per-direction counter strictly advanced.

### C. In-session rekey

- **Counter ratchet** (hygiene; every 10k frames or 15 min): `k' = HKDF-Expand(HKDF-Extract("dash-rekey-v1", k), "dash rekey", 32)`, counter→0, old `k` wiped. No new entropy.
- **DH re-handshake** (true PCS; ≥ every 30 min or every reconnect): full fresh-ephemeral handshake mixing a new `ss_ee`. PCS is claimed *only* at this cadence — documented honestly.

### Forward secrecy & revocation

- Past traffic stays secret if a stored static key later leaks (the attacker also needs the long-discarded ephemerals). Static compromise allows only future impersonation until revocation.
- **Revocation = delete the device row (`S_p.pub`)** AND simultaneously (a) close the live relay session and (b) tell the relay DO to drop the `linkId` + forget `slotSecretHash`. Tested as a first-class operation, not assumed.

## Frame format

Two layers; the relay sees only the outer WS binary message (≤ 32 MiB; one AEAD record per message):

```
WS binary message
└── OUTER AEAD record:  ciphertext ‖ tag(16)
      cipher = IETF ChaCha20-Poly1305
      key    = k_g2p | k_p2g (per direction)
      nonce  = 12B = [4B zero][8B BE recordSeq]   (per-direction counter; never random, never reset under a live key)
      AAD    = OUTER HEADER (authenticates version, direction, recordSeq)
      plaintext = INNER FRAME: inner-header(16B) ‖ payload
```

**Outer header (AAD, 10 bytes, authenticated not encrypted):** `protoVer=1` (1B); `direction` (1B: 0x01 gw→phone, 0x02 phone→gw); `recordSeq` (8B uint64 BE, per-direction monotonic — receiver rejects `≤` last accepted; doubles as the nonce counter).

**Inner header (plaintext, 16 bytes, big-endian):** `ver=1` (1B); `type` (1B opcode); `flags` (1B: bit0 FINAL, bit1 CHUNKED); `reserved=0` (1B); `streamId` (4B uint32, 0 = control; gateway-initiated EVEN, phone-initiated ODD); `chunkIndex` (4B); `payloadLen` (4B). Payloads remain today's JSON (UTF-8) — no re-encoding. Binary header so TS `DataView` and Kotlin `ByteBuffer` parse identically.

**Opcodes:** control (streamId 0, never chunked) `0x00 PING`, `0x01 PONG`, `0x02 CLOSE`, `0x03 ERROR_GLOBAL`, `0x04 HANDSHAKE`. Chat `0x10 CHAT_START` (phone→gw), `0x11 CHAT_EVENT` (`{seq?, event}`), `0x12 CHAT_DONE`, `0x13 CHAT_ERROR`, `0x14 CHAT_CANCEL`, `0x15 CHAT_ANSWER`. Management `0x20 REQ` `{method,path,query?,headers?,body?}`, `0x21 RESP` `{status,headers?,body?}`. Reserved: `0x30–0x33` subscriptions (Phase-1-optional), `0x40–0x4F` file/blob (Phase 2), `0xF0–0xFF` experimental.

**Handshake bootstrap:** `0x04` frames precede transport keys, so they're not sealed with `k_*`; integrity comes from the HMAC/key-confirmation construction. After step 8, all frames use the outer AEAD with `recordSeq` from 0 under the fresh key.

**Chunking** (endpoint concern; relay forwards verbatim): `MAX_FRAME_PAYLOAD = 1 MiB`. Larger messages split into N chunks sharing `streamId`+`type`, `chunkIndex` strictly +1, `FINAL=1` on last; per-stream reassembly cap 32 MiB; gap/dup/out-of-order = fatal stream error.

**Resume:** `CHAT_START` MAY carry `resumeFromSeq`; honored only after a completed fresh handshake on the current connection, bound to the per-connection server nonce (no replay into another session).

**Heartbeat / close:** app-level `PING`/`PONG` on streamId 0 every ~25 s idle, inside the encrypted channel (detects a relay black-holing one direction); 2 missed `PONG`s → tear down. Control frames bypass backpressure. Decrypt failure / version mismatch / `recordSeq` regression / chunk-order violation → `ERROR_GLOBAL` then close.

## Relay design (`apps/relay`)

**Topology:** one Worker + one `RelayLink` DO per `linkId` via `env.LINK.idFromName(linkId)` (the `linkId` *is* the DO name — race-free, enumeration-free, no registry). SQLite-backed DO (`new_sqlite_classes`) for free-tier eligibility.

**Worker (stateless):** require `Upgrade: websocket` (else 426); shape-check `linkId` (exactly 32 base64url chars — cheap reject before spawning a DO); per-IP connect rate-limit (`cf.connectingIp`, ~30/60 s → 429); `getByName(linkId).fetch(request)`.

**Two-slot model + anti-hijack:** at most two slots (`gateway`, `phone`) tagged via `ctx.acceptWebSocket(server,[role])`, recovered post-hibernation via `getTags`. Slot-auth is a single-use server-challenged HMAC (`HMAC(slotSecret, freshChallenge)` vs stored `slotSecretHash`) — anti-DoS only, captured URLs not replayable; `slotSecret` never sent in cleartext. Authoritative `LinkRecord{linkId, state, createdAt, gwSlotAuthHash, phSlotAuthHash, pairedAt?}` in `ctx.storage` (never JS-field-only — survives hibernation).

**Lifecycle:** gateway-only `create` (first-writer-wins, `state` absent); phone can only *join* an existing pending link (phone-before-gateway → 4404, retry with backoff). Reconnect: re-challenge, verify HMAC, evict stale role socket, accept new, notify peer — **but the gateway requires a completed fresh E2E handshake before resuming any stream or honoring `resumeFromSeq`**. Idle paired links hibernate for free (optional 7-day IDLE_TTL GC). Teardown via `{type:'unlink'}` closes both + `deleteAll()`; desktop unpair always sends it so transport revocation is simultaneous with the device-key delete. Slot contention surfaces to the desktop as a "someone else tried to pair" security alert.

**Hibernation:** `ctx.acceptWebSocket` (not `ws.accept()`); `setWebSocketAutoResponse` for edge-liveness pings. Edge ping ≠ peer liveness — the E2E `PING/PONG` is the source of truth for peer-offline UI.

**Backpressure / abuse:** relay forwards verbatim (O(1) memory, never chunks/reassembles); per-peer 8 MiB in-flight high-water throttles fast senders, 24 MiB hard ceiling → close 1013; per-link ~200 frames/s token bucket → 1008; control frames bypass the gate; zone WAF + Cloudflare DDoS. **Not Turnstile** (clients are a Node process + native app, not browsers). The relay stores only hashes — a compromised relay still cannot pair, MITM, or replay a slot claim.

## Gateway integration (verified file refs)

- **New module** `apps/gateway/src/tunnel-client.ts` exporting `initTunnelClient(options): Promise<{start, stop, stats}>`.
- **Startup** `index.ts`: insert `initTunnelClient(...)` after `registry.load()` (line 121) and before the channel server binds (lines 337–347); pass `{chatToken, managementToken, dataDir, logger, credentialStore, eventLogStore, relayUrl, agentRegistry}`. Shutdown handler (line 366): `await tunnelClient.stop()` first, before `mcpManager.stop()` and `eventLogStore.close()` (line 377).
- **Key storage** reuse `credential-store.ts` (AES-256-GCM `credentials.enc` + 0600 `secret.key`): `relay:gateway:static:{priv,pub}` (generated on first run), `relay:authorized-devices` (JSON map). The management bearer `token` stays here and never traverses the relay (follows the existing `channel:<name>:token` convention).
- **Chat bridge** `chat-ws.ts` (`/ws/chat` at line 143): tunnel-client opens one persistent loopback WS to `ws://127.0.0.1:9200/ws/chat?token=<chatToken>`, maps `CHAT_*` ↔ existing `WsClientMessage`/`WsServerMessage`; existing `seq` carries through.
- **Management bridge** `management-api.ts` (bearer middleware lines 124, 234+; `/health` exempt): on a `REQ` frame, `fetch('http://127.0.0.1:9300'+path, {method, headers:{...headers, Authorization:'Bearer '+managementToken}, body})` — token injected locally only — reply `RESP` correlated by `streamId`. Native `fetch`, no new dep.
- **Resume** `event-log-store.ts` (`append→seq`, `readSince` lines 49/56) + HTTP replay (`/agents/:id/conversations/:cid/events?sinceSeq=N`, lines 651–662): after a fresh handshake, replay missed entries (preserving `seq`) then resume live.
- **Crypto** Node built-ins verified present: `generateKeyPairSync('x25519')`, `diffieHellman`, `hkdfSync('sha256')`, `chacha20-poly1305` (IETF); `xchacha20-poly1305` absent. `crypto.ts` already uses `createCipheriv` (AES-256-GCM) — same idiom. Zero new gateway crypto deps.
- **Config** `config.ts` (`parseFlags` lines 5/26–27): add `--relay-url` with precedence `DASH_RELAY_URL` env > config `relay.url` > baked `DEFAULT_RELAY_URL`; add `relay: { url, enabled }` to `config/dash.json` (deep-merged).

## Operating model & ops

- **Single Dash-hosted shared relay** is the default. Worker + SQLite-backed DO on a Dash Cloudflare account; custom domain (e.g. `relay.dash.<domain>`, not `workers.dev`); separate dev/prod environments; hibernation on.
- `relayUrl` overridable (`DASH_RELAY_URL` > config > baked default) for self-host.
- Cost: order-of-magnitude tens of $/mo at modest scale assuming hibernation holds; validate against real CLI-client traffic before committing to absorb at scale.
- `wrangler.jsonc` (sketch): the `RelayLink` DO binding, a `new_sqlite_classes` migration, `compatibility_date`, route on the custom domain, per-env config.

## Threat model & adversarial findings

Three independent attacker lenses each returned **weakened** (core handshake sound; surrounding design flawed). All fixes are folded into this spec.

1. **Relay-as-attacker → nonce reuse.** A malicious relay force-drops the socket; if the E2E key persisted but the counter reset, ChaCha20-Poly1305 reuses `(key, nonce=0)` → confidentiality + forgery against `:9300`. **Fix:** fresh handshake every connection (no key persistence); direction in AAD; one canonical framing; mutual key-confirmation before authorization/bearer injection.
2. **QR-observation race (TOFU).** The QR carries `psk` verbatim; a photographed QR lets an attacker bind their device. **Fix:** mandatory SAS human-confirmation on the desktop before committing the phone key; `psk` single-use + wiped on all paths; `PENDING_TTL` 75 s; one-time ephemeral QR.
3. **Forward-secrecy / reconnect → replayable credential.** `slotAuth` derived from `psk` was both "wiped" and "required on every reconnect" — resolving into a replayable bearer token gating a non-re-authenticated reconnect. **Fix:** `slotSecret` separated from `psk`; relay slot-auth is single-use challenge-response, anti-DoS only; reconnect mandates a fresh authenticated handshake; `resumeFromSeq` gated behind it; per-connection nonces in the transcript; guard against ephemeral reuse.

Confirmed sound: the core handshake (pairing-secret never traverses the relay; a key-swapping relay can't complete the handshake — degrades to DoS, not compromise).

## Residual risks (accepted / to monitor)

1. **Metadata at the shared relay** — `linkId`, source IPs, timing, byte counts visible (never content/token/psk). Documented; self-host is the escape hatch.
2. **Single point of failure / DoS magnet** — one Dash endpoint; mitigated by CF DDoS + rate limits + per-DO caps + 75 s TTL, not eliminated.
3. **Static-key compromise** permits future impersonation until revocation (FS protects only past traffic); revocation is multi-step and must be tested.
4. **VM-snapshot / RNG-reseed ephemeral reuse** would break FS for affected sessions; mitigation (refuse ephemeral reuse) depends on correct implementation.
5. **Bounded PCS** — counter ratchet adds no entropy, so PCS holds only at the DH re-handshake cadence (≤30 min / reconnect).
6. **Rate-limit counters are per-CF-location** (approximate global limits); paired with WAF + per-link DO enforcement.
7. **Cross-runtime crypto parity** (IETF-vs-non-IETF ChaCha, BE encoding, AAD ordering, IKM order) is the top implementation risk — lock the checked-in interop test vector before Phase 2.
8. **Cost estimate is order-of-magnitude** — validate against real traffic.

## Testing

- `packages/relay-protocol`: unit tests for frame encode/decode, chunk reassembly, `recordSeq` monotonicity rejection, and the **cross-runtime crypto test vector**.
- `apps/relay`: DO unit tests (Vitest + workers pool) for slot model, challenge-response, hibernation state survival, lifecycle/TTL, rate limits.
- Gateway: cross-runtime crypto vector alongside `crypto.ts`; tunnel-client itself exercised end-to-end by the TS CLI client (the acceptance harness).
- Update `apps/mission-control/TEST_PLAN.md` with a pairing/SAS/revocation section when MC surfaces the QR + SAS UI (Phase 4).

## Deferred to later phases

- Kotlin mirror of `relay-protocol` + Android Keystore + CameraX/ML Kit QR scan (Phase 2).
- Subscriptions opcodes (`0x30–0x33`) implementation; file/blob opcodes (Phase 2).
- Mission Control "Link a phone" + "Linked devices" UI (Phase 4).
- FCM offline delivery (Phase 4).
