# Dash for iOS

Dash for iOS is a native SwiftUI client for chatting with agents and managing them from an
iPhone or iPad. The gateway remains authoritative: the app reads cached conversations offline,
reconciles when connectivity returns, and never runs an agent on the device.

## Supported scope

- Sign in with your Dash account and connect to any gateway enrolled through Mission Control's
  Remote access, over the hosted relay (no QR/paste/manual entry).
- Read archived conversations and create, rename, or delete canonical conversations.
- Stream chat, resume interrupted turns, answer agent questions, cancel active turns, and attach
  supported images.
- Read and administer agents through the gateway-owned model catalog and configuration.
- Inspect connection health and remove one gateway's secrets, cache, and drafts from this device.

The app requires gateway capabilities `conversation-sync-v1` and `chat-resume-v1`. It does not
provide provider credential UI, gateway shutdown controls, connector administration, or project
lifecycle controls.

## Prerequisites

- macOS with Xcode 16.3 selected. The pinned simulator scripts reject other Xcode versions.
- An iOS 17 or newer device, or the iOS 18.4 simulator runtime used by this repository's tests.
- Node.js 22 when running the shared contract checks or real-gateway integration harness.

The project generator is pinned to XcodeGen 2.45.4 and authenticated by checksum. Prepare the
project from the repository root:

```bash
ios/scripts/bootstrap-xcodegen.sh
ios/scripts/generate-project.sh
ios/scripts/check-project.sh
open ios/Dash.xcodeproj
```

`ios/Dash.xcodeproj` is committed. Regenerate and commit it whenever source membership changes.
The AppIcon is deterministically derived from `apps/website/app/icon.svg`; regenerate it with:

```bash
ios/scripts/generate-app-icon.sh
git diff --exit-code -- ios/Dash/Resources/Assets.xcassets/AppIcon.appiconset
```

## Build and test

Create or verify the pinned simulator devices first:

```bash
ios/scripts/ensure-simulators.sh
ios/scripts/ensure-simulators.sh --iphone-udid
ios/scripts/ensure-simulators.sh --ipad-udid
```

Build the app without signing:

```bash
xcodebuild -project ios/Dash.xcodeproj -scheme Dash \
  -destination 'generic/platform=iOS Simulator' \
  build CODE_SIGNING_ALLOWED=NO

xcodebuild -project ios/Dash.xcodeproj -scheme Dash \
  -destination 'generic/platform=iOS' \
  build CODE_SIGNING_ALLOWED=NO
```

Run unit and contract tests on the pinned phone:

```bash
IPHONE_UDID="$(ios/scripts/ensure-simulators.sh --iphone-udid)"
xcodebuild -project ios/Dash.xcodeproj -scheme Dash \
  -destination "platform=iOS Simulator,id=$IPHONE_UDID" \
  test CODE_SIGNING_ALLOWED=NO
```

Compile the real-gateway suite, then run deterministic UI coverage:

```bash
xcodebuild -project ios/Dash.xcodeproj -scheme DashIntegration \
  -destination 'generic/platform=iOS Simulator' \
  build-for-testing CODE_SIGNING_ALLOWED=NO

IPHONE_UDID="$(ios/scripts/ensure-simulators.sh --iphone-udid)"
xcodebuild -project ios/Dash.xcodeproj -scheme DashUI \
  -destination "platform=iOS Simulator,id=$IPHONE_UDID" \
  test CODE_SIGNING_ALLOWED=NO
```

The integration target composes production HTTP, SSE, WebSocket, persistence, and sync types.
Build the Node workspaces once, verify the runner contract, then run either one exact selector or
the complete six-case live matrix:

```bash
npm run build
npx vitest run ios/scripts/run-live-gateway-tests.test.ts

node ios/scripts/run-live-gateway-tests.mjs --scenario question \
  --only-testing \
  DashIntegrationTests/ChatResumeIntegrationTests/testQuestionAnswer

node ios/scripts/run-live-gateway-tests.mjs
```

The runner requires the pinned iOS 18.4 iPhone, starts a fresh repository gateway harness for each
selector, requires exactly one passed and non-skipped test, and stops at the first failure. It
scopes every test value to the simulator test host, removes them in `finally`, and terminates
the harness without printing its credentials. Successful result bundles are removed; a failed
selector keeps its secret-free `ios/LiveGateway-*.xcresult` for CI diagnostics. Never put tokens in
a committed scheme or command history.

A separate harness, `ios/scripts/run-live-account-flow-test.mjs`, exercises the account sign-in
path end to end against a real (locally spun-up) control plane, relay, and gateway: a
sign-in-shaped mint, `AccountConnectFeature.connect`, relay-verified install, then one chat
round-trip:

```bash
node ios/scripts/run-live-account-flow-test.mjs
```

It targets whatever `iPhone 17 Pro` simulator is already available on the host (no
Xcode-16.3-pinned preflight) and runs exactly
`DashIntegrationTests/LiveAccountFlowTests/testAccountSignInMintAndChat`. Running the
`DashIntegration` scheme directly, without either harness script, fails 7 tests — the 6
pre-existing LAN/relay pairing cases `run-live-gateway-tests.mjs` drives plus this account-flow
test — each with a precise "missing environment variable" error instead of a silent skip. That
7-test baseline is expected and honest, not a regression.

## Run on a physical iPhone

`ios/scripts/deploy-device.sh` builds the app and installs it on a paired iPhone over Wi-Fi — no
cable, no TestFlight round trip.

```bash
ios/scripts/deploy-device.sh              # build, install, launch once
ios/scripts/deploy-device.sh --watch      # redeploy every time a source file changes
ios/scripts/deploy-device.sh --list       # show paired devices
```

The build uses a `generic/platform=iOS` destination, so it compiles a signed device `.app` whether
or not the phone is awake; only the install step waits for the device. `devicectl` then pushes and
launches it. Use `--watch` while iterating: save a file, and the phone has the new build shortly
after.

### One-time setup

1. **Pair the phone for wireless development.** Connect it by cable once, open Xcode >
   Window > Devices and Simulators, select the phone and tick **Connect via network**. After that
   the cable is unnecessary.
2. **Enable Developer Mode** on the phone: Settings > Privacy & Security > Developer Mode.
3. **Trust the signing certificate** on the phone the first time you deploy, and again whenever
   Xcode issues a new one: Settings > General > VPN & Device Management > Developer App > Trust.
   Until you do, the app installs but iOS refuses to launch it with "profile has not been
   explicitly trusted by the user".
4. **Give the build a signing identity.** Automatic signing needs an Apple ID that belongs to the
   team in `Config/Local.xcconfig` (`DEVELOPMENT_TEAM`). Sign in under Xcode > Settings >
   Accounts, or create an App Store Connect API key and put it in `~/.dash-ios-deploy.env`:

   ```bash
   ASC_KEY_PATH=/path/to/AuthKey_XXXXXXXX.p8
   ASC_KEY_ID=XXXXXXXX
   ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

   The API key route is fully headless and is the same file `deploy-testflight.sh` reads. Without
   one of these the build fails with `No Account for Team` / `No profiles for 'app.dash.ios'`.

   `DEVELOPMENT_TEAM` must be the **Team ID**, which is the `OU` field of your signing
   certificate — *not* the identifier in parentheses after your email, which is a different thing
   and produces a confusing `No Account for Team <id>` error. Read it with:

   ```bash
   security find-certificate -c "Apple Development" -p |
     openssl x509 -noout -subject          # OU=<team id>
   ```

### Free Personal Team limits

If your Apple ID has no paid Apple Developer Program membership, Xcode signs with a free
"Personal Team". That is enough for both scripts here, with two consequences:

- **Provisioning profiles expire after 7 days.** The installed app stops launching after that
  and you have to deploy again. A paid membership raises this to a year.
- **TestFlight is unavailable.** `deploy-testflight.sh` needs a paid membership; a Personal Team
  cannot create distribution certificates or upload to App Store Connect.

The phone must be unlocked and on the same network as the Mac for the install step; a sleeping
phone stops advertising itself and the script waits (`DASH_IOS_WAIT`, default 120s) before giving
up.

## Install over the tailnet

`deploy-device.sh` only works on the local network. Apple discovers wireless devices with
Bonjour/mDNS, which is multicast; Tailscale is a layer-3 overlay with no multicast, so `devicectl`
cannot see a phone that is only reachable over the tailnet — it will answer pings and still report
`unavailable`.

`ios/scripts/deploy-tailnet.sh` takes the other route: it exports a development-signed `.ipa`,
serves it over Tailscale HTTPS, and lets iOS install it over the air. That works anywhere the
phone has the tailnet, cellular included.

```bash
ios/scripts/deploy-tailnet.sh            # build, publish, print the install URL
ios/scripts/deploy-tailnet.sh --stop     # take the serve down when you're done
```

Open the printed URL on the iPhone and tap **Install**.

The macOS Tailscale app is sandboxed and refuses to serve a directory ("Path serving is not
supported on macOS"), so the script runs a local static server on `127.0.0.1:8787`
(`DASH_IOS_PORT`) and has Tailscale proxy that port. `--stop` shuts down both the proxy and that
server.

Requirements:

- **HTTPS must be enabled** for your tailnet in the Tailscale admin console. iOS refuses an OTA
  install without a valid certificate, and Tailscale's `*.ts.net` certs satisfy it. The script
  checks this and stops early with a clear message if it is off.
- **The phone must already be registered** with the development team. Registration only happens
  when a build targets the real device, so run `deploy-device.sh` once with the phone on the local
  network before using this script. A free Personal Team will not issue a profile at all until at
  least one device is registered, and a `generic/platform=iOS` destination — which this script
  uses, since the phone may be remote — cannot register one.
- Every run bumps `CURRENT_PROJECT_VERSION`, so iOS treats each deploy as an upgrade and keeps
  your existing app data.

iOS cannot install an app silently — only an MDM-enrolled device can. So this path always ends in
one tap on the phone; there is no way around that short of enrolling the device in an MDM.
`deploy-testflight.sh` is the third option: it reaches the phone anywhere without Tailscale and
adds Apple's processing delay (~5-15 min), but it requires a paid Apple Developer Program
membership.

## Sign in

Dash for iOS connects through a Dash account rather than a QR/paste/manual pairing code. Open the
app and tap **Sign In** — a browser sheet (`ASWebAuthenticationSession`) drives the Clerk OAuth
round trip. Once signed in, `GatewayPickerView` lists every gateway enrolled in the account
(`ControlPlaneClient.listGateways`) by its relay subdomain. Tapping a gateway runs
`AccountConnectFeature.connect(to:)`: it mints a fresh pairing grant from the control plane for
that gateway, turns it into a relay `PairingPayload` (v2, port 443, both mobile tokens equal to
the grant's chat token), and verifies + installs it through the exact same machinery QR/manual
pairing used (`PairingVerifying`, `PairingProfileInstalling`, `Features/Pairing` below) — so the
account path is relay-only and never offers a QR/paste/manual fallback.

A gateway only appears in the picker once it has been enrolled from Mission Control's
**Settings → Devices → Remote access**, which registers both the relay address and this app's
chat capability. A gateway enrolled before this app's account sign-in shipped has the relay
address but never registered the chat capability; tapping it fails instead of connecting. Opening
Mission Control once on the machine that runs that gateway updates the gateway's app access
automatically — `healEnrolledGatewayChatToken` (`apps/mission-control/src/main/ipc.ts`) re-pushes
the chat token for any already-enrolled gateway on every local-gateway launch, so no user action
beyond starting Mission Control is needed.

`GatewayPickerViewModel`'s `AccountCopy` constants are exact, binding UI copy — do not paraphrase
them elsewhere:

| State | Exact copy |
| --- | --- |
| Control plane unreachable while loading gateways | Couldn't reach your Dash account service. Check your connection and try again. |
| Account has no enrolled gateways | No gateways linked to your account yet. Open Mission Control → Settings → Devices → Remote access to enroll this machine. |
| Gateway enrolled before this app's account sign-in shipped (`chatToken` absent) | This gateway needs to be re-enrolled from Mission Control before app access works. |

`GatewayPickerView`'s toolbar has **Sign Out**, which tears down any active gateway connection,
best-effort revokes an abandoned mint, drops the cached account token, and returns to `SignInView`.

Before saving anything, the connect pipeline validates the payload, checks gateway health and
identity, and requires the mobile capabilities above. Connection secrets are then stored in
Keychain. SwiftData stores gateway-scoped profiles, conversations, messages, cursors, agents,
drafts, and attachment metadata without those secrets.

## Local architecture

| Area | Responsibility |
| --- | --- |
| `Core/Contracts` | Strict Swift mirrors of `contracts/mobile/v1`, including forward-compatible agent events. |
| `Core/Networking` | Authenticated `/mobile/v1` HTTP, SSE invalidations, capable WebSocket chat, and reachability. |
| `Core/Security` | Device-only Keychain storage for the Mobile bearer and optional relay credential. |
| `Core/Persistence` | Gateway-scoped SwiftData cache, replay cursors, drafts, insert-only pending sends, durable deletion revision floors, and external attachment data. |
| `Core/Sync` | Cache-first bootstrap, canonical reconciliation, tombstones, replay gaps, and reconnect backoff. |
| `Features/Account` | Account sign-in (Clerk-hosted browser flow) and the gateway picker that lists enrolled gateways. |
| `Features/Pairing` | Shared verify + install machinery reused by account sign-in's connect flow; the QR/paste/manual entry UI is no longer reachable from the app. |
| `Features/Conversations` | Canonical list mutations, transcript projection, resumable chat, recovery, answers, cancel, and images. |
| `Features/Agents` | Cache-first agent list, safe owned-field edits, enable/disable/delete, and Start Chat. |
| `Features/Settings` | Sanitized gateway status, reconnect, and secure Disconnect & Forget. |

The gateway is the source of truth. Cached rows remain readable during an outage, while canonical
writes are disabled. A foreground transition refreshes canonical state and restarts invalidation
events. The visible chat separately replays durable events before its running turn resumes.
A canonical deletion or not-found response raises a hidden gateway-scoped revision floor before
cached content is purged. Same-gateway reactivation preserves that floor, so stale or equal
summaries and late message or cursor writes remain suppressed.
Only a strictly newer canonical active summary can revive the conversation ID.

Messages whose admission could not be confirmed remain durably pending across launches and are
never retried automatically, and insert-only staging prevents a second send from overwriting the
saved record. An explicit retry reuses the original turn ID so gateway admission is idempotent while
the conversation still exists. If another client deleted the conversation, Dash
never recreates or resends the message. The **Needs Recovery** section keeps it.
Open the recovery item to copy the exact text, preview or share its readable attachments, and
explicitly confirm discarding it. Dash uses the same manual recovery flow for
unreadable saved attachment data and for an earlier rejected message that collides with a separately
saved newer draft. In the collision case, both payloads survive in one recovery item. You can copy
either text and preview or share readable attachments from either copy. If the conversation is
active, discarding the earlier message preserves the newer draft in the composer. If it is
unavailable, the confirmation makes clear that discarding removes both copies. Dash rechecks that
status before deletion; if it changed while the confirmation was open, the app stops and asks you
to review and confirm again. The affected chat stays read-only until you explicitly discard the
recovery item. Corrupt attachment data cannot be previewed or shared, but the exact text for that
copy remains available.
Disconnect & Forget stops transports before deleting Keychain material, purging that gateway's
SwiftData cache, and clearing the selected profile.

## Troubleshooting

### Update Dash

If the app reports **Update Dash**, the gateway advertises a newer incompatible mobile API or is
missing `conversation-sync-v1` or `chat-resume-v1`. Update the older side, then reconnect. Do not
retry mutations against an incompatible contract.

### Re-pair required

An unauthorized response means the stored credentials are no longer accepted. Cached content
stays visible but read-only. Open **Settings** and use **Disconnect & Forget**, then sign back in
and tap the gateway again in the picker — the account connect path always mints a fresh grant, so
no QR code is involved.

### Rate limited (HTTP 429)

Dash shows the gateway-provided retry window and keeps cached content visible. Wait for the
countdown instead of repeatedly reconnecting or resending a mutation.

### Relay returns HTTP 502

A relay 502 normally means the relay cannot currently reach the gateway. Confirm the gateway is
online and registered with the relay, then use Reconnect. Only fall back to Disconnect & Forget
and reconnecting from the gateway picker if the relay credential or gateway identity changed.

### LAN connection fails (pairing pipeline tests only)

The shipped app UI only offers the account sign-in path above, which is always relay-mode. This
applies to `PairingPipelineTests` and `run-live-gateway-tests.mjs`'s LAN cases, which still
exercise `Features/Pairing`'s verify + install machinery directly: confirm the iPhone and gateway
share a reachable network, the host contains no scheme or path, and the pinned-TLS mobile port is
reachable. Dash does not enable an ATS cleartext exception and never falls back from HTTPS/WSS to
plaintext.

### iOS 18.4 runtime is missing

Run:

```bash
ios/scripts/ensure-simulators.sh
```

With Xcode 16.3 selected, the script downloads the pinned runtime when necessary and creates exact
iPhone 16 Pro and iPad Pro 13-inch (M4) device types. If Xcode reports another active developer
directory, select Xcode 16.3 with `xcode-select` and retry.
