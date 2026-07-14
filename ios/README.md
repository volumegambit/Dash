# Dash for iOS

Dash for iOS is a native SwiftUI client for chatting with agents and managing them from an
iPhone or iPad. The gateway remains authoritative: the app reads cached conversations offline,
reconciles when connectivity returns, and never runs an agent on the device.

## Supported scope

- Pair with a Dash gateway over LAN or relay by scanning, pasting, or entering a pairing code.
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
selector, and stops at the first failure. It scopes all seven test values to the simulator test
host, removes them in `finally`, and terminates the harness without printing its credentials. Never
put tokens in a committed scheme or command history.

## Pair a gateway

Open Dash and choose one of three paths:

1. **Scan QR Code** uses the camera to read a pairing payload displayed by Dash.
2. **Paste Pairing Code** reads a complete payload already on the clipboard.
3. **Enter Manually** accepts the connection fields without camera access.

For LAN pairing, the phone and gateway must be reachable on the same network. Enter the gateway
host, management and chat ports, transport security choice, and the two gateway-issued tokens.
For relay pairing, enter the relay host, gateway management and chat tokens, and the per-device
relay credential from the pairing payload. Relay connections use TLS on port 443. Do not
substitute a management URL for the host field.

Before saving anything, the app validates the payload, checks gateway health and identity, and
requires the mobile capabilities above. Connection secrets are then stored in Keychain. SwiftData
stores gateway-scoped profiles, conversations, messages, cursors, agents, drafts, and attachment
metadata without those secrets.

## Local architecture

| Area | Responsibility |
| --- | --- |
| `Core/Contracts` | Strict Swift mirrors of `contracts/mobile/v1`, including forward-compatible agent events. |
| `Core/Networking` | Authenticated `/mobile/v1` HTTP, SSE invalidations, capable WebSocket chat, and reachability. |
| `Core/Security` | Device-only Keychain storage for management, chat, and relay credentials. |
| `Core/Persistence` | Gateway-scoped SwiftData cache, replay cursors, drafts, and external attachment data. |
| `Core/Sync` | Cache-first bootstrap, canonical reconciliation, tombstones, replay gaps, and reconnect backoff. |
| `Features/Pairing` | QR, paste, and manual pairing with identity verification. |
| `Features/Conversations` | Canonical list mutations, transcript projection, resumable chat, answers, cancel, and images. |
| `Features/Agents` | Cache-first agent list, safe owned-field edits, enable/disable/delete, and Start Chat. |
| `Features/Settings` | Sanitized gateway status, reconnect, and secure Disconnect & Forget. |

The gateway is the source of truth. Cached rows remain readable during an outage, while canonical
writes are disabled. A foreground transition refreshes canonical state and restarts invalidation
events. The visible chat separately replays durable events before its running turn resumes.
Disconnect & Forget stops transports before deleting Keychain material, purging that gateway's
SwiftData cache, and clearing the selected profile.

## Troubleshooting

### Update Dash

If the app reports **Update Dash**, the gateway advertises a newer incompatible mobile API or is
missing `conversation-sync-v1` or `chat-resume-v1`. Update the older side, then reconnect. Do not
retry mutations against an incompatible contract.

### Re-pair required

An unauthorized response means the stored credentials are no longer accepted. Cached content
stays visible but read-only. Generate a new pairing payload at the gateway and pair again. If you
intend to remove all local data first, use **Disconnect & Forget**.

### Rate limited (HTTP 429)

Dash shows the gateway-provided retry window and keeps cached content visible. Wait for the
countdown instead of repeatedly reconnecting or resending a mutation.

### Relay returns HTTP 502

A relay 502 normally means the relay cannot currently reach the gateway. Confirm the gateway is
online and registered with the relay, then use Reconnect. Re-pair only if the relay credential or
gateway identity changed.

### LAN connection fails

Confirm the iPhone and gateway share a reachable network, Local Network access is enabled for
Dash in Settings, the host contains no scheme or path, and both configured ports are reachable.
The app permits local networking through ATS but does not enable arbitrary insecure loads.

### Camera or local networking in Simulator

Simulator camera behavior does not fully match a physical iPhone. Use Paste Pairing Code or Enter
Manually when no camera feed is available. Local-network routing also depends on the Mac and may
not reproduce device firewall, Wi-Fi isolation, VPN, or captive-network behavior.

### iOS 18.4 runtime is missing

Run:

```bash
ios/scripts/ensure-simulators.sh
```

With Xcode 16.3 selected, the script downloads the pinned runtime when necessary and creates exact
iPhone 16 Pro and iPad Pro 13-inch (M4) device types. If Xcode reports another active developer
directory, select Xcode 16.3 with `xcode-select` and retry.
