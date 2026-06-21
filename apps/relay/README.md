# Dash Relay

The relay lets the **Dash phone app reach a gateway running on your home or office
machine from anywhere on the internet** — without port-forwarding, a static IP, or
exposing the gateway directly.

It is a small, self-hostable Node service. You run **one** relay; every gateway you
own dials into it and becomes reachable at its own subdomain.

> **Note:** the relay is a self-hosted component today. The in-app "Pair over relay"
> flow in Mission Control and the Android app is being finalized; until then you can
> deploy and exercise the relay with the gateway flags and the admin API documented
> below.

---

## When you need it

- **You need it** to reach your agents from your phone when you're away from home — the
  gateway sits behind NAT/a firewall with no public address.
- **You don't need it** when your phone and gateway are on the same Wi-Fi/LAN. Pair
  directly over the local network instead (Mission Control → Pair Device).

---

## How it works

The relay is a **reverse tunnel**. Crucially, the gateway connects *out* to the relay —
outbound connections pass through NAT and firewalls, inbound ones don't.

```
 Phone  ──HTTPS/WSS──▶  Relay  ──┐                         (gateway dials OUT:
(anywhere)            (public TLS) │  one persistent WSS     one socket, then
                                   ▼                         requests flow back
                                Gateway ──127.0.0.1──▶ its own loopback servers
                              (behind NAT)              (management :9300, chat :9200)
```

1. The **gateway dials out** one persistent WebSocket to the relay and registers under a
   stable `gatewayId`.
2. A **phone** reaches a gateway at `https://<gatewayId>.<your-zone>` (and
   `wss://<gatewayId>.<your-zone>/ws/chat`). The relay routes by the `Host` subdomain.
3. Each phone request is **multiplexed** as a stream onto the gateway's single socket.
4. The gateway **replays** each stream against its own `127.0.0.1` servers and pipes the
   response back. The gateway is "just another localhost client" to itself — its servers
   and auth are untouched.

The relay pipes **opaque bytes**. It never inspects, logs, or persists your message
content or your gateway tokens.

### Three independent auth layers (all end-to-end)

| Layer | Secret | Checked by | On failure |
|-------|--------|-----------|------------|
| Gateway admission | relay token (Bearer on dial-in) | relay | WS close `4401` |
| Per-pairing credential | `x-dash-relay-credential` header | relay (against its store) | `401` / WS `4401` |
| App ↔ gateway | management Bearer / chat `?token=` | **the gateway** (forwarded verbatim) | gateway's own `401`/`4001` |

---

## Quick start (local)

Run a relay and a gateway on your own machine and drive it with `curl`. Requires
Node.js 22.12+ (the gateway needs 22.12+ for `undici`).

```bash
# From the repo root — build the relay and gateway
npm run build

# 1. Start the relay (admin API on, so pairing credentials are enforced)
node apps/relay/dist/main.js --port 8788 --relay-token devrelay --admin-secret devadmin &

# 2. Start a gateway that dials the relay as gateway "demo"
node apps/gateway/dist/index.js \
  --management-port 9355 --channel-port 9255 \
  --token devmgmt --chat-token devchat \
  --data-dir /tmp/dash-relay-demo \
  --relay-url ws://127.0.0.1:8788 --relay-token devrelay --gateway-id demo &

# 3. Provision a per-device pairing credential (admin secret required)
CRED=$(curl -s -X POST -H "Authorization: Bearer devadmin" \
  -H "content-type: application/json" -d '{"gatewayId":"demo"}' \
  http://127.0.0.1:8788/admin/pairings | python3 -c 'import sys,json;print(json.load(sys.stdin)["credential"])')

# 4. Make a phone-style request through the relay.
#    Host picks the gateway; the credential gets past the relay; the Bearer is the
#    gateway's own token, forwarded untouched.
curl -s -H "Host: demo.relay.local" \
     -H "x-dash-relay-credential: $CRED" \
     -H "Authorization: Bearer devmgmt" \
     http://127.0.0.1:8788/agents          # → [] (200)
```

Without the credential you get `401`; with a wrong gateway Bearer you get `401`
*from the gateway* (the relay forwarded it). For a one-command, fully-automated check,
run `npm run relay:e2e`, which spawns a real relay + real gateway and asserts the whole
round-trip.

> For a dev relay without credential enforcement, omit `--admin-secret`. Pairing
> credentials are then accepted permissively (the gateway tokens remain the real auth).

---

## Production deployment

The relay binds loopback by default; **Caddy** terminates TLS in front of it and serves a
**wildcard** certificate for `*.relay.<your-zone>` so every gateway gets its own
subdomain. Wildcards require ACME **DNS-01**, so you need a Caddy build with your DNS
provider's plugin. The ready-made artifacts are in [`deploy/`](deploy/).

### 1. DNS

Point a wildcard at your relay host:

```
*.relay.example.com.   A   <relay server public IP>
```

### 2. Caddy (wildcard TLS + reverse proxy)

Build Caddy with your DNS provider plugin and use [`deploy/Caddyfile`](deploy/Caddyfile):

```bash
xcaddy build --with github.com/caddy-dns/cloudflare   # swap in your provider
```

The Caddyfile reverse-proxies `*.relay.{$RELAY_ZONE}` to the loopback relay and preserves
the `Host` header (which the relay uses to route). WebSocket upgrades are proxied
transparently.

### 3. systemd

Install [`deploy/dash-relay.service`](deploy/dash-relay.service) and an environment file
based on [`deploy/relay.env.example`](deploy/relay.env.example):

```bash
sudo cp apps/relay/deploy/dash-relay.service /etc/systemd/system/
sudo install -m 600 apps/relay/deploy/relay.env.example /etc/dash-relay/relay.env
sudo nano /etc/dash-relay/relay.env          # set RELAY_ZONE, RELAY_TOKEN, RELAY_ADMIN_SECRET, DNS token
sudo systemctl enable --now dash-relay
```

The unit is hardened (`DynamicUser`, `ProtectSystem=strict`, loopback bind behind Caddy).

### 4. Point your gateway at it

Start (or have Mission Control start) the gateway with:

```bash
--relay-url wss://relay.example.com --relay-token <same as RELAY_TOKEN> --gateway-id <stable id>
```

The gateway then registers and is reachable at `https://<gatewayId>.relay.example.com`.

---

## Configuration reference

### Relay (`apps/relay/dist/main.js`)

| Flag | Env | Default | Meaning |
|------|-----|---------|---------|
| `--port` | `RELAY_PORT` | `8443` | Port to listen on (Caddy proxies to it). |
| `--host` | `RELAY_HOST` | `127.0.0.1` | Bind address. Loopback by default (Caddy fronts it); use `0.0.0.0` to expose directly. |
| `--relay-token` | `RELAY_TOKEN` | — *(required)* | Shared secret a gateway must present to register. |
| `--admin-secret` | `RELAY_ADMIN_SECRET` | — *(optional)* | Enables the admin API and real pairing-credential enforcement. |

### Gateway relay mode

| Flag | Meaning |
|------|---------|
| `--relay-url` | Relay base URL, e.g. `wss://relay.example.com`. Enables relay mode with `--relay-token`. |
| `--relay-token` | Must equal the relay's `RELAY_TOKEN`. |
| `--gateway-id` | Stable id the relay routes by (`<gatewayId>.<zone>`). If omitted, the gateway generates and persists one under its data dir. |

---

## Pairing & the admin (control) API

When `--admin-secret` is set, the relay validates a real, revocable per-pairing
credential and exposes a Bearer-gated admin API. Mission Control calls these to
provision a credential at pair time and revoke it on un-pair.

```bash
# Provision a credential for a gateway (one per paired device)
curl -X POST -H "Authorization: Bearer $RELAY_ADMIN_SECRET" \
  -H "content-type: application/json" -d '{"gatewayId":"<id>"}' \
  https://admin.relay.example.com/admin/pairings
# → { "gatewayId": "<id>", "credential": "<256-bit credential>" }

# Revoke one credential (omit "credential" to revoke every device for the gateway)
curl -X POST -H "Authorization: Bearer $RELAY_ADMIN_SECRET" \
  -H "content-type: application/json" -d '{"gatewayId":"<id>","credential":"<cred>"}' \
  https://admin.relay.example.com/admin/pairings/revoke
# → { "ok": true }
```

- The phone presents the credential as the `x-dash-relay-credential` header on every
  request and WebSocket upgrade.
- `/admin/*` is matched by path ahead of subdomain routing and is reachable at any
  subdomain that resolves to the relay (the admin secret is the gate). Calls without the
  secret get `401`.
- The credential store is **in-memory** — a relay restart drops all pairings and Mission
  Control re-provisions on reconnect. This keeps a relay that's only a pass-through from
  holding standing access on disk.

---

## Security posture

- **Three independent auth layers** (table above). The relay never sees inside the gateway
  tokens — it forwards them and the gateway authenticates.
- **Constant-time** comparison for the relay token, admin secret, and pairing credentials.
- **No payload logging or persistence.** The relay pipes opaque bytes.
- **Loopback by default.** The Node process binds `127.0.0.1`; Caddy is the only public
  listener.
- **Abuse limits per gateway**: a token-bucket rate limit (default 50 req/s, burst 100)
  and a concurrent-stream cap (default 256). Over-limit HTTP gets `429`, WebSocket gets
  close `4429`.
- **Backpressure**: credit-based flow control means a slow phone throttles the upstream
  instead of letting the relay buffer without bound.
- **Resilience**: if the relay restarts, the gateway re-dials with exponential backoff,
  and a ping/pong heartbeat detects a dead peer.

---

## Status codes & troubleshooting

| You see | Meaning | Fix |
|---------|---------|-----|
| `502 No gateway connected` | No gateway is registered for that subdomain | Start the gateway in relay mode; check it logs `[relay] connected`. |
| `401 Unauthorized` (HTTP) | Missing/invalid pairing credential, **or** the gateway rejected the forwarded token | Provision a credential; verify the gateway's own token. |
| `429 Too Many Requests` | Rate limit or stream cap for that gateway | Back off; the bucket refills. |
| WS close `4401` | Bad relay token (gateway dial-in) or invalid pairing credential | Check `--relay-token` matches; re-provision. |
| WS close `4429` | Phone throttled | Back off and retry. |

**Logs.** The relay logs lifecycle only (listening, admin enabled, connections) — never
payloads. The gateway logs `[relay] connected` / `[relay] socket error` so you can watch
dial-out and reconnects.

```bash
npm run relay        # run the relay from source (tsx), prints to stdout
npm run relay:e2e    # full local end-to-end smoke (real relay + real gateway)
```
