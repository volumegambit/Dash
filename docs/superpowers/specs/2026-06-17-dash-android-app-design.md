# Dash Android App — Umbrella Design

**Date:** 2026-06-17
**Status:** Umbrella design (Sections 1–2). Each phase gets its own spec → plan → implementation cycle.

## Problem

Dash is local-first: agents, tools, and conversations all run on the user's machine, and the gateway that hosts them binds to `127.0.0.1` only. Mission Control (a desktop Electron app) is the sole way to chat with and manage agents. There is no way to reach your agents from a phone while away from the desk.

We want a native Android app that is a full Mission Control companion — both **chat** with deployed agents and **manage** them (deploy, configure, enable/disable, view models/connectors/channels/logs) — without weakening the local-first security posture more than necessary.

The central obstacle: the gateway is loopback-bound and behind NAT, so a phone on a different device/network cannot reach it directly. Connectivity is the core of the design, not an afterthought.

## Goals

- Native Android app that can chat with and manage Dash agents from anywhere (including cellular).
- Preserve as much of the local-first guarantee as possible: no third party should be able to read chat content or management commands.
- The gateway's management bearer token must never leave the desktop.
- Each piece (transport, app, relay) has a well-defined interface and is independently buildable/testable.

## Non-goals (v1)

- iOS (native Kotlin chosen; cross-platform deferred).
- Multi-user / team accounts. Pairing is device-to-gateway, not account-based.
- Replacing Mission Control. The phone is a companion, not the primary console.

## Decisions (the five pillars)

1. **Scope** — full companion: chat *and* management.
2. **Connectivity** — cloud relay. The gateway dials *out*; the phone connects *in*; the relay bridges them.
3. **Relay** — Cloudflare Worker + Durable Object.
4. **App stack** — native Kotlin + Jetpack Compose.
5. **Security** — QR pairing, X25519 key exchange, end-to-end encrypted payloads, **zero-knowledge relay** (it only ever sees ciphertext + a `linkId` for routing).

## Architecture

Four surfaces:

```
   ┌─────────────────┐         ┌──────────────────────┐        ┌─────────────────────────┐
   │  Android app    │  WSS    │  Cloudflare relay    │  WSS   │  Your machine           │
   │ (Kotlin/Compose)│ ──────► │  Worker + Durable    │ ◄───── │ ┌─────────────────────┐ │
   │                 │ ◄────── │  Object (per link)   │ ──────►│ │ Gateway tunnel-client│ │
   │  holds phone    │ cipher  │  pipes opaque        │ cipher │ │  (new)              │ │
   │  X25519 key     │  text   │  ciphertext by linkId│  text  │ └──────────┬──────────┘ │
   └─────────────────┘         └──────────────────────┘        │   loopback │ (plaintext) │
            ▲                                                   │ ┌──────────▼──────────┐ │
            │ scans QR                                          │ │ Chat WS  :9200      │ │
   ┌────────┴────────┐                                          │ │ Mgmt API :9300      │ │
   │ Mission Control │  "Link a phone" screen shows the QR      │ └─────────────────────┘ │
   │ (desktop)       │  (gateway generates the pairing payload) │   gateway holds its     │
   └─────────────────┘                                          │   own X25519 key + token│
                                                                └─────────────────────────┘
```

1. **Android app** — chat + management UI. Holds the phone's device key. Speaks the *same* chat-WS and management-HTTP semantics the desktop uses, but every payload is AEAD-encrypted and tunneled through the relay.
2. **Cloudflare relay (Worker + DO)** — one Durable Object per link. Holds the gateway's persistent socket and the phone's socket and pipes ciphertext between them, routed only by `linkId`. Never holds an app key. Uses the WebSocket **Hibernation API** so an idle gateway connection accrues no duration billing.
3. **Gateway tunnel-client (new)** — dials *out* to the relay over WSS and keeps the connection alive (reconnect with backoff). Decrypts inbound frames and proxies them to the loopback chat WS / management API, then encrypts responses back. The only piece bridging ciphertext ↔ the existing plaintext loopback servers.
4. **Mission Control (desktop)** — a "Link a phone" screen that asks the gateway to start a pairing and renders the returned payload as a QR, plus a "Linked devices" list to revoke. *(Phase 1 uses an `mc-cli pair` command that prints an ASCII QR, so transport can be proven before MC UI exists.)*

### Why a Cloudflare DO relay fits the gateway's needs

The gateway exposes three connection "types," but the tunnel-client **multiplexes all three onto a single encrypted WebSocket** as application-level frames, so the relay only ever carries one thing — a bidirectional stream of discrete messages between two inbound clients (the canonical DO "chat room" pattern):

1. **Chat** — long-lived bidirectional streaming WS (`:9200`) → `message`/`event`/`done` frames.
2. **Management** — request/response HTTP (`:9300`) → `{method, path, headers, body}` → `{status, body}` frames.
3. **Log/event streams** — server-push SSE (`/logs/stream`, `/events`) → subscribe frame → event frames.

Because the gateway is loopback-bound and behind NAT, it **dials out** — so both the gateway and the phone are *inbound* clients to the Worker/DO; the relay never initiates a connection. This also satisfies the hibernation constraint ("Hibernation is only supported when a Durable Object acts as a WebSocket **server**").

Verified against Cloudflare docs (2026-06-17): DO can coordinate/relay among multiple inbound WS clients; binary frames supported; **32 MiB** max received message size; **unlimited** connection duration while connected; Hibernation API keeps idle connections free.

## Pairing flow (one time, per phone)

1. Gateway creates a link: ephemeral X25519 keypair, random `linkId`, random `pairingSecret`; opens its persistent WSS to the relay and registers `linkId` as "awaiting phone."
2. The QR encodes `{ relayUrl, linkId, gatewayPubKey, pairingSecret }` — the out-of-band channel the relay never sees.
3. Phone scans, generates its own X25519 keypair, connects to the relay with `linkId`; the DO joins it to the gateway.
4. Both run an **authenticated** ECDH: each already knows the other's real public key (gateway's via the QR; the phone's sent over the wire but MAC'd with `pairingSecret`). They HKDF a key, mixing in `pairingSecret`. Because the relay never saw `pairingSecret`, it **cannot MITM** — a swapped key fails the MAC.
5. Gateway stores the phone's public key as an authorized device; phone stores `{ linkId, relayUrl, gatewayPubKey }`; `pairingSecret` is discarded.

## Steady-state data flow

1. Phone connects to the relay with `linkId`; the DO pairs it to the gateway's live socket. Both derive a fresh per-session key.
2. **Chat** — phone sends the normal chat message shape (`{type:'message', id, agentId, conversationId, text, images?}`), encrypted; gateway decrypts → forwards to loopback `:9200` → streams `AgentEvent` frames back, each encrypted.
3. **Management** — phone sends an encrypted `{method, path, headers, body}`; gateway performs the loopback HTTP call to `:9300` and returns the encrypted response.

### Chat protocol facts (grounding for Phase 2)

- Loopback endpoint (gateway side only): `ws://127.0.0.1:9200/ws/chat?token=<chatToken>`. The phone never opens this — it sends the message frames below *into the tunnel*, and the gateway tunnel-client owns the loopback WS connection (and the token).
- Outbound: `{ type:'message', id, agentId, channelId, conversationId, text, images?, streamingBehavior?: 'steer'|'followUp' }`, plus `{ type:'cancel', id }`.
- Inbound frames: `{ type:'event', id, seq?, event }`, `{ type:'done', id, seq? }`, `{ type:'error', id, seq?, error }`.
- `AgentEvent` variants to render: `text_delta`, `thinking_delta`, `tool_use_start`, `tool_use_delta`, `tool_result`, `response` (with `usage`), `error`, `file_changed`, `agent_spawned`, `agent_retry`, `context_compacted`, `question` (id/question/options), `skill_loaded`, `skill_created`, `mcp_server_error`.

### Management endpoints (grounding for Phase 3)

Base `http://<gateway>:9300`, `Authorization: Bearer <token>` (injected by the gateway, not the phone). Key sets: `/health`, `/info`, agents CRUD + enable/disable + skills (`/agents…`), channels CRUD (`/channels…`), credentials (`/credentials…`), models (`/models`, `/models/refresh`), logs (`/logs`, `/logs/stream`), MCP servers (`/runtime/mcp/servers…`, `/runtime/mcp/allowlist`), optional projects/issues/inbox, event-replay (`/agents/:id/conversations/:cid/events?sinceSeq=`), SSE (`/events`).

## Security properties

1. **Zero-knowledge relay** — only ever sees ciphertext + a `linkId`.
2. **The gateway's bearer token never leaves the desktop** — the phone's authorization *is* its paired device key; the gateway injects the loopback token itself. Revoking a phone = deleting its public key on the gateway.

## Transport requirements (folded-in caveats)

1. **Chunked framing** — single relay frames must stay ≤ 32 MiB; the tunnel layer chunks/streams anything approaching it (large file reads, big log tails).
2. **Reconnect + resume** — no forced WS timeout, but deploys/edge maintenance can drop sockets. Gateway and phone reconnect with backoff; chat recovers missed stream events via `seq` + the event-replay endpoint.
3. **Heartbeat** — app-level ping/pong so a hibernated-but-dead socket is detected promptly.
4. **Offline delivery is not the relay's job** — when the phone has no live socket, delivery goes via FCM push (Phase 4), not the relay.

## Sequencing

**Spine-first vertical slice.** Build the encrypted transport end-to-end first, proven by round-tripping a *real* chat turn and a *real* management call through it via a CLI test client. The relay/E2E/dial-out spine is the riskiest, most novel part and its frame format is the contract every other piece depends on — freeze it by proving it works, then build UI confidently.

## Phase breakdown (four independently shippable sub-projects)

**Phase 1 — Secure transport spine** *(the foundation)*
- `packages/relay-protocol` (TS) — frame + handshake types, E2E crypto helpers; single source of truth for the wire format.
- `apps/relay` — CF Worker + Durable Object: accept-only, hibernation, `linkId` routing, chunked framing, heartbeat.
- Gateway tunnel-client — dial-out, reconnect-with-backoff, E2E crypto, proxy to loopback `:9200`/`:9300`, inject bearer locally.
- Pairing via `mc-cli pair` printing an ASCII QR.
- **Done =** a CLI test client pairs by QR and round-trips a real chat turn *and* a `GET /agents` call through the encrypted relay; reconnect resumes a chat via `seq`/event-replay.

**Phase 2 — Android chat client**
- QR-scan pairing (CameraX + ML Kit/ZXing); device key in Android Keystore; OkHttp WS + E2E crypto (libsodium/Tink); Kotlin mirror of `relay-protocol`.
- Chat UX: agent picker, conversation list, streaming view rendering all `AgentEvent` variants, image attach, cancel + steer/followUp.
- **Done =** pair + multi-turn chat with a real agent, tool calls visible, over cellular.

**Phase 3 — Android management**
- Agent list/detail, deploy/edit (model dropdown from `GET /models`), enable/disable/delete, MCP connectors CRUD, channels view, logs viewer (tail + SSE stream), health/info.
- **Done =** common management operations reach parity with the desktop.

**Phase 4 — Background, notifications & polish**
- Foreground service for live streams; FCM push for agent replies and `question` events when backgrounded; MC desktop "Link a phone" + "Linked devices" UI replacing the CLI pairing; multi-gateway support.

Phases 2 and 3 can overlap once Phase 1's tunnel contract is frozen; Phase 4 is polish on top.

## Repo layout

1. **This monorepo** (TS, fits tsup/vitest/biome) holds all transport pieces so the gateway and relay share one `relay-protocol` package and evolve in lockstep: `packages/relay-protocol`, `apps/relay` (wrangler-deployed), the gateway tunnel-client module, the `mc-cli pair` command, and the Phase 4 MC UI.
2. **A separate `dash-android` repo** for the Kotlin/Gradle app — it doesn't fit npm workspaces, and a separate repo keeps toolchains and CI clean. Its wire types are hand-mirrored from `relay-protocol` (small JSON; could codegen later).

## Open questions (to nail down in the Phase 1 spec)

- Exact crypto primitives: X25519 + HKDF-SHA256 + XChaCha20-Poly1305 (libsodium on both ends) vs. Noise Protocol framework (e.g. Noise XK) for the handshake.
- Frame format details: framing header, message-id correlation for multiplexed request/response, chunk sequencing for >32 MiB.
- Relay link lifecycle: how long a pairing-pending link lives; how the DO authenticates the gateway's reconnect; rate limiting.
- Where the gateway's long-term device key and authorized-phone list are stored (keychain vs `data/`).
- Relay deployment/ops: account, custom domain, wrangler config, environments.
