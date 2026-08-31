# Dash Web

A static single-page app that lets a browser chat with a Dash gateway over the
[hosted relay](../relay/README.md) and [control plane](../relay-control-plane) — the
same infrastructure the phone apps use for remote access. There is no server-side
component here: `apps/web` builds to a static `dist/` and is served from its own
origin, same as any SPA.

For the end-user guide (sign in, pick a gateway, chat, troubleshooting), see
[docs/web.mdx](../../docs/web.mdx). This README is for whoever builds and deploys it.

## Build

```bash
# From the repo root
npm install
npm run web:build   # tsc --noEmit && vite build → apps/web/dist
```

`apps/web/dist` is a static bundle — HTML, JS, CSS. Deploy it to any static host
(the hosted relay's infrastructure, a CDN, a bucket with a web front, etc.). There is
nothing to run continuously; there's no Node process to keep alive.

```bash
npm run web:dev              # local dev server (Vite)
npm run preview -w apps/web  # serve the production build locally
npm test -w apps/web         # vitest run
```

## Deploy: its own origin

Serve `dist/` at its own origin, separate from the control plane and from any
gateway — for example `https://app.<relay-domain>`. The app is entirely static, so
any static host works as long as:

- It serves `index.html` for unknown paths (client-side routing has none today, but
  a hard refresh on `/` must still work).
- It sets the **Content-Security-Policy** header below (or an equivalent
  `<meta>` tag — see [`index.html`](index.html), which already ships one and is the
  source of truth this section mirrors; `src/csp.test.ts` fails if the two drift).
  Set it at the host in production so it can't be stripped or altered by an
  intermediary that only understands HTTP headers.

```
Content-Security-Policy: default-src 'self'; connect-src 'self' %VITE_CONTROL_PLANE_URL% https://*.%VITE_RELAY_DOMAIN% wss://*.%VITE_RELAY_DOMAIN% https://*.clerk.accounts.dev https://*.clerk.com; script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com; worker-src 'self' blob:; base-uri 'self'; form-action 'self'; object-src 'none'
```

The `VITE_` placeholders are substituted by Vite at build time from the same
environment variables documented below, so the rendered `index.html` already
carries this policy pinned to your control plane and relay domain. When you set
the header at the host instead, substitute them yourself — with the *same* values
the bundle was built with.

Notes on that policy:

- `connect-src` is pinned to exactly three network destinations: the control
  plane, any gateway subdomain under your relay domain, and Clerk. It replaces an
  earlier blanket `https:`, which allowed the app to talk to any HTTPS origin at
  all — a meaningful difference given the pairing credential lives in IndexedDB
  and is therefore readable by any script that runs on this origin.
- `wss://*.<relay-domain>` is listed separately and is **load-bearing**: `connect-src`
  governs WebSockets too, but an `https://` source does not match a `wss://` URL,
  so without it the chat socket is blocked while REST keeps working.
- `img-src` allows any `https:` origin plus `data:` (inline icons/pasted images).
  This is deliberately broader than the rest of the policy: assistant replies can
  contain markdown image links pointing at arbitrary remote hosts, which isn't a
  fixed allowlist the way the control plane/relay/Clerk origins are.
  `react-markdown`'s `defaultUrlTransform` strips `javascript:`/`data:` image
  sources before they reach the DOM, so this doesn't reopen the XSS the rest of
  the policy guards against. `https://img.clerk.com` (Clerk's avatar CDN) is
  subsumed by the blanket `https:`.
- `script-src` allows only Clerk's own script origins in addition to `'self'` — no
  other third-party script origins are needed. `frame-src` and `worker-src` cover
  Clerk's sign-in widget internals.
- If you serve the web client under a different Clerk configuration (a Clerk
  production instance has its own frontend-API domain, e.g. `clerk.example.com`),
  add that origin to `script-src`, `connect-src` and `frame-src`.

> **Launch checklist:** the Clerk directives above are derived from Clerk's
> documented load points, not from an observed production render. Before going
> live, open the deployed app in a real browser with this policy active, complete
> a full passkey sign-in, and confirm the console reports **zero** CSP violations
> — a Clerk instance on a custom domain in particular will need its own origin
> added. Do this against the header the host serves, not just the `<meta>` tag.

## Environment variables

Set these at build time (Vite inlines `import.meta.env.VITE_*` into the bundle, so
each is fixed per build/deploy — there's no runtime config file):

| Variable | Required | Meaning |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key for the Clerk application used for sign-in. Passkeys must be enabled for this application in the Clerk dashboard — that's dashboard configuration, not something this app sets. Missing/empty renders a configuration-error screen instead of crashing (see `AppRoot.tsx`). |
| `VITE_CONTROL_PLANE_URL` | Yes | Base URL of the relay control plane (`apps/relay-control-plane`), e.g. `https://cp.<relay-domain>`. Used for listing gateways and minting/revoking pairings. |
| `VITE_RELAY_DOMAIN` | Yes | Domain the hosted relay is served under. Combined with a gateway's `subdomain` to build its REST base (`https://<subdomain>.<relayDomain>/mobile/v1`) and WS base (`wss://<subdomain>.<relayDomain>/ws/chat`) — see `src/config.ts` and `src/ui/Shell.tsx`. |

Example `.env.production` (not committed):

```
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
VITE_CONTROL_PLANE_URL=https://cp.relay.example.com
VITE_RELAY_DOMAIN=relay.example.com
```

## Config that must line up elsewhere

The web client is one of several pieces that all have to agree on the deployed
origin and on Clerk. Nothing here is web-specific plumbing — it's the same trust
chain the design doc for this feature describes, wired through config:

| Where | What to set | Why |
|---|---|---|
| Gateway (`apps/gateway`) | Usually **nothing** — see below. `DASH_WEB_ORIGINS` (comma-separated exact origins) overrides. | Gates the gateway's `/mobile/v1` CORS allowlist for browser `fetch`/`XHR`. A relay-enrolled gateway defaults to allowing `https://app.<relay zone>`, derived from the relay URL it dials, so the standard deployment needs no per-machine configuration. Native/mobile clients are unaffected either way — they don't send `Origin`. |
| Control plane (`apps/relay-control-plane`) | `RELAY_CP_WEB_ORIGINS` (env) or `--web-origins` (flag), comma-separated exact origins | Gates CORS on `/v1/*` and `/gw/dial-token` for the browser calls this app makes (listing gateways, minting/revoking pairings). Same rule: unset/empty disables CORS on those routes. |
| Control plane | Clerk OIDC config (`RELAY_CP_CLERK_FRONTEND_API`, `RELAY_CP_CLERK_CLIENT_ID`) | Must point at the **same Clerk application** as this app's `VITE_CLERK_PUBLISHABLE_KEY`, or the control plane can't verify the ID token this app sends. |
| Relay (`apps/relay`) | Nothing to configure for this — noted for context | The relay exempts CORS preflights (`OPTIONS`) to canonical mobile targets from its credential check so the gateway's CORS allowlist stays the single origin-policy holder, and rate-limits those preflights on a separate, tighter bucket (`preflightBurst` default 10, `preflightRatePerSec` default 5 per gateway — internal defaults, not currently exposed as flags/env). If browser requests get unexpectedly rate-limited, this is why. |

### The gateway's default allowlist

A gateway enrolled with the hosted control plane dials
`wss://<gatewayId>.<relay zone>`, so it can work out where the web client lives:
it allows `https://app.<relay zone>` automatically. Deploying this app at that
origin — the layout "Deploy: its own origin" above recommends — means there is
nothing to set on each user's machine.

`DASH_WEB_ORIGINS` takes precedence whenever it is present:

| `DASH_WEB_ORIGINS` | Result |
|---|---|
| unset | `https://app.<relay zone>` when relay-enrolled; no origins otherwise |
| `https://a.example, https://b.example` | exactly those — to *extend* rather than replace, list the default alongside your own |
| set but empty | no origins at all: browser access to this gateway is off |

A gateway that is not relay-enrolled derives nothing (there is no zone to derive
from) and so has CORS disabled unless `DASH_WEB_ORIGINS` says otherwise.

In short: pick the web client's deployed origin first. If it is
`https://app.<relay zone>` the gateway already agrees; otherwise put that exact
origin in `DASH_WEB_ORIGINS`. Either way it must also be in the control plane's
`RELAY_CP_WEB_ORIGINS`/`--web-origins`, which has no such derivation. A mismatch
shows up as a browser CORS error at the relevant hop, not as an application
error message.

## Auth model (what this client actually holds)

Summarized from the design doc's as-built amendment
(`docs/plans/2026-08-29-web-interface-design.md`); read that for the full rationale.

1. The browser signs in with Clerk (passkey-first — see `src/ui/SignIn.tsx`).
2. It calls the control plane to mint a **web pairing**:
   `POST /v1/gateways/:id/pairings/pairing-id-v1` → `{ credential, pairingId, chatToken }`.
   The plain `/v1/gateways/:id/pairings` route (no `pairing-id-v1` suffix) is a
   legacy Mission-Control-compat route that returns only `{ credential }` — no
   `pairingId`, no `chatToken` — so it can't be used here.
   - `credential` is a per-device, individually revocable relay pairing credential.
   - `chatToken` is the gateway's **gateway-wide chat-scoped bearer** — the same one
     Mission Control embeds in QR pairings — registered with the control plane by
     Mission Control's Remote-access enroll flow (`PUT /v1/gateways/:id/web-chat-token`).
   - Gateways enrolled before this feature shipped haven't registered a chat token
     yet, so this call returns **409** (`no web chat token registered for this
     gateway`) until the owner re-runs enroll from Mission Control. See
     `GATEWAY_NEEDS_REENROLL_COPY` in `src/ui/GatewayPicker.tsx`.
3. REST calls carry `Authorization: Bearer <chatToken>` plus an
   `x-dash-relay-credential` header (the per-device credential) — see
   `MobileRestClient` in `src/api/rest.ts`. This is how the store lists
   conversations and replays message history (`getMessages`); this build's data
   flow is REST-cursor replay + WS for live frames, not SSE, though `src/api/sse.ts`
   ships a fetch-based `text/event-stream` reader for the mobile/v1 SSE surface (it
   only sets `Authorization` today — it isn't wired into the app's own reconnect
   path, since that goes through the WS ticket flow below).
4. The chat WebSocket carries the relay credential via `Sec-WebSocket-Protocol`
   (browsers can't set arbitrary headers on a WS upgrade) and a short-lived,
   single-use `?ticket=` the gateway issues and redeems — see `src/api/chat-socket.ts`.

Consequence worth knowing: revoking a web pairing from the Devices screen revokes
this browser's relay reach, but **not** the chat bearer it already received (that
bearer is gateway-wide, not per-device). Tighter per-device isolation is a
reversible follow-up, not something this build does.

A pairing credential rejected as a 401 by the relay or gateway (revoked from
another device, from Mission Control, or expired) puts the store's `connection`
into a terminal `'unauthorized'` state — it never silently retries an auth
failure. `Shell.tsx` notices that state, clears the local `CredentialStore` entry
for that gateway, and routes back to the gateway picker with
`SESSION_REVOKED_COPY`: *"Your web session for this gateway was revoked. Pair
again to continue."* Picking the gateway again mints a fresh pairing and clears
the notice.

## Testing

```bash
npm test -w apps/web     # vitest run — unit + component tests, mocked control plane/gateway
```

An integration test also exists that drives the web client against a real gateway —
`src/integration/web-gateway.integration.test.ts` boots the gateway's mobile test
harness and runs `MobileRestClient`/`ChatSocket`/`createWebAppStore` end to end with
no mocks (list → create conversation → ws-ticket → real WS upgrade → send →
streamed completion → transcript). It runs as part of `npm test -w apps/web`.
