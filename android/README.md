# Dash Android App

A native Android client for [Dash](../README.md). It's a thin **remote client** to a
running Dash gateway — it does **not** run agents on-device or spawn the gateway
(that stays Mission Control's job on the desktop).

**v1 scope:** chat with your agents (streaming) and monitor/toggle them. Deploying
agents, connectors, projects, messaging channels, and the relay are out of scope for v1.

## Architecture

Native **Kotlin + Jetpack Compose**, **MVVM + Repository + Flow**. A multi-module
Gradle project that talks to the gateway's existing HTTP management API (`:9300`) and
chat WebSocket (`:9200/ws`). Streamed `AgentEvent`s arrive as a Kotlin `Flow` from an
OkHttp WebSocket.

```
android/
  core/model          Kotlin DTOs mirroring the TS wire types + kotlinx.serialization
  core/network        GatewayClient (REST) + ChatSocket (WebSocket → Flow<AgentEvent>)
  core/connection     ConnectionProfile, pairing-payload parser, encrypted ProfileStore
  core/designsystem    Compose theme mirroring Mission Control's palette
  feature/agents      Agents list + detail + enable/disable (ViewModels + screens)
  feature/chat        Streaming chat: reducer + ViewModel + screen
  feature/pairing     Manual entry + CameraX/ML Kit QR scanner
  app                 AppContainer DI, navigation, manifest, theme → the APK
```

**Dependency injection** is a hand-rolled `AppContainer` (created in `DashApplication`)
plus a small `viewModelFactory { }` helper — no Hilt/KSP, which keeps the build simple
for v1's small graph. ViewModels take their dependencies via constructor (or functional
seams), so they're unit-testable without Android.

**Contract source of truth (TypeScript).** The `core/model` DTOs mirror these files;
keep them in sync:
- `packages/agent/src/types.ts` — `AgentEvent`, content blocks
- `apps/gateway/src/chat-ws.ts` — `WsClientMessage` / `WsServerMessage` (the live
  `/ws/chat` route + `agentId`; **not** the unmounted legacy `packages/chat/src/chat-server.ts`)
- `apps/gateway/src/agent-registry.ts` — `RegisteredAgent`

Unknown `AgentEvent` variants decode to `AgentEvent.Unknown` rather than throwing, so a
newer gateway won't break the chat stream.

## Prerequisites

- **JDK 17** (Android Gradle Plugin 8.x requirement)
- **Android SDK** with platform 34 + build-tools 34

A one-shot bootstrap for macOS (installs JDK 17 + Android command-line tools, no Android
Studio needed):

```bash
./scripts/setup-toolchain.sh
source "$HOME/android-sdk/env.sh"   # puts JAVA_HOME + sdk tools on PATH
```

If you use Android Studio, just open the `android/` directory and let it sync.

## Build & test

```bash
cd android
./gradlew test            # JVM unit tests for every module (no device needed)
./gradlew assembleDebug   # builds app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:installDebug   # install onto a connected device/emulator
```

The unit suite covers serialization round-trips, the REST client + WebSocket Flow, the
pairing parser + encrypted store, and every ViewModel/reducer. **Instrumented Compose UI
tests require a device/emulator and are not part of `./gradlew test`.**

CI runs `./gradlew test` + `assembleDebug` via `.github/workflows/android.yml`, triggered
only on `android/**` changes (separate from the Node CI so each toolchain stays isolated).

## Connecting in development (before the relay exists)

The app needs a gateway **host + management token + chat token**. Two ways to get them:

1. **Pair via QR (recommended).** In Mission Control, open **Pair Device** and scan the QR
   with the app. The QR encodes the desktop's LAN IP + both tokens.
2. **Manual entry.** Type the host/IP and paste both tokens on the app's connect screen.

For a device/emulator that should reach a gateway on *this* machine:

```bash
# Same Wi-Fi: use the Mac's LAN IP (shown on the Pair Device screen), or
# tunnel localhost over USB/emulator with adb reverse:
adb reverse tcp:9300 tcp:9300   # management API
adb reverse tcp:9200 tcp:9200   # chat WebSocket
# then pair with host = localhost
```

Connection details are stored in an encrypted DataStore (Android Keystore-backed). The WS
token currently travels as a `?token=` query param over plain `ws://` on the LAN — fine
for the same-network/dev posture, and hardened to TLS by the future **Dash relay**, which
slots in as a new `ConnectionProfile` (the app's `secure` flag flips `ws→wss`/`http→https`)
with no other changes.

## Roadmap

- **Dash relay** — reach the desktop gateway from anywhere (adds TLS + a real pairing
  handoff). The app is already structured for it behind `ConnectionProfile`.
- **Push notifications**, deploy/connectors/projects parity, and instrumented UI tests.
