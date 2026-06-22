# Dash Android — Phase 1 (Secure Transport Spine) Implementation Plans

**Date:** 2026-06-17
**Spec:** [`docs/superpowers/specs/2026-06-17-dash-android-phase1-transport-spine-design.md`](../specs/2026-06-17-dash-android-phase1-transport-spine-design.md)
**Umbrella:** [`docs/superpowers/specs/2026-06-17-dash-android-app-design.md`](../specs/2026-06-17-dash-android-app-design.md)

Phase 1 is split into **four sequential per-unit plans**. Each unit is authored against the *previous* units' real frozen interfaces, so the control-plane and data-plane wire contracts cannot diverge across units. Build them in order.

| # | Plan | Builds | Tasks |
|---|------|--------|-------|
| A | [phase1a — relay-protocol](./2026-06-17-dash-android-phase1a-relay-protocol.md) | `packages/relay-protocol` — the wire contract: frame codec, crypto helpers, **and the single canonical control plane** (relay-join/slot-auth signaling + E2E handshake messages) + cross-runtime test vector | 24 |
| B | [phase1b — relay](./2026-06-17-dash-android-phase1b-relay.md) | `apps/relay` — Cloudflare Worker + `RelayLink` Durable Object (zero-knowledge ciphertext pipe, hibernation, slot-auth, lifecycle) | 19 |
| C | [phase1c — gateway tunnel](./2026-06-17-dash-android-phase1c-gateway-tunnel.md) | `apps/gateway/src/tunnel-client.ts` (dial-out, fresh-handshake-every-connection, chat/management/resume bridges) **+ the gateway pairing server** (`/pairing/*`, SAS-gated atomic commit) | 16 |
| D | [phase1d — mc-cli pairing + harness](./2026-06-17-dash-android-phase1d-cli-pairing.md) | `apps/mc-cli` `pair` command (QR + SAS) and the end-to-end acceptance harness (the Phase 1 "Done" gate) | 19 |

**Build order is strict:** A → B → C → D. A must build first (the others import `@dash/relay-protocol`); D's live acceptance run needs B and C running.

## Phase 1 "Done" criterion

The acceptance harness in Plan D (Task 19) pairs by QR + SAS and round-trips **a real chat turn** *and* **a real `GET /agents`** through the encrypted relay, then survives a forced reconnect that transparently re-handshakes and resumes the chat via `seq`/event-replay.

## Key design invariants (enforced across all four plans)

1. **One canonical control plane** lives in `@dash/relay-protocol` (Plan A); relay, gateway, and CLI all import it — no unit reinvents slot-auth or handshake signaling.
2. **Fresh mutually-authenticated handshake on every connection** (no E2E key persistence). The gateway sends `cfm_g` and **requires the phone's `cfm_p`** on every session/reconnect connection; during pairing the SAS is the auth gate and `cfm_p` is not used.
3. **Gateway slot-secret continuity:** the pairing server persists `relay:gateway:slot:<linkId>` and reconnect reads the same key, so the relay accepts reconnects.
4. **Resume** is gateway-driven via `eventLogStore.readSince(...)` (the gateway replays missed events; it does not rely on the chat-ws honoring `resumeFromSeq`).
5. **Zero-knowledge relay:** stores only `sha256(slotSecret)`; never sees plaintext, the bearer token, the pairing secret, or `slotSecret`.

## Provenance

These plans were authored sequentially (contract-first) and passed an adversarial completeness/seam critique. A prior single mega-plan was discarded because its contract froze only the data plane, letting each unit invent incompatible control-plane signaling and omit the gateway pairing server. This split structure plus the unified control-plane contract is the fix.
