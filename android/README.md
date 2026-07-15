# Dash Android App

A native Android client for [Dash](../README.md). It's a thin **remote client** to a
running Dash gateway — it does **not** run agents on-device or spawn the gateway
(that stays Mission Control's job on the desktop).

**v1 scope:** chat with your agents (streaming) and monitor/toggle them over a local or
already-paired relay connection. Deploying agents, connectors, projects, messaging channels,
and configuring remote access remain in Mission Control.

## Architecture

Native **Kotlin + Jetpack Compose**, **MVVM + Repository + Flow**. A multi-module
Gradle project that talks to the gateway's pinned-TLS mobile API
(`https://<host>:9400/mobile/v1`) and chat WebSocket
(`wss://<host>:9400/ws/chat`). Streamed `AgentEvent`s arrive as a Kotlin `Flow` from an
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
- `contracts/mobile/v1/fixtures/pairing-*.json` and `invalid/pairing-*.json` — accepted and
  rejected pairing payloads consumed directly by Android unit tests
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

CI runs `./gradlew test` + `assembleDebug` via `.github/workflows/android.yml`. It runs for Android
changes and for gateway, agent-event, or pairing-wire changes that can affect this legacy client
(separate from the Node CI so each toolchain stays isolated).

## Connecting

The app needs a gateway **host + phone-scoped Mobile token**. Local pairing also pins the
gateway certificate; relay pairing adds a revocable device credential. Two ways to connect:

1. **Pair via QR (recommended).** In Mission Control, open **Settings → Devices** and scan
   the QR in the **Pair Device** card with the app. LAN pairing payloads use version 3 and
   include the desktop's LAN IP, Mobile token, port 9400, and exact SHA-256
   leaf-certificate fingerprint.
2. **Manual entry (advanced local recovery).** Type the host/IP, Mobile token, and certificate
   SHA-256 fingerprint. The local port is fixed at 9400. Mission Control deliberately keeps the
   token and fingerprint inside the QR instead of displaying copyable values, so the normal user
   flow is QR scanning; manual entry is for operators who already obtained those values through
   trusted local development tooling.

For a device/emulator that should reach a gateway on *this* machine:

```bash
# Same Wi-Fi: use the Mac's LAN IP shown in Settings → Devices, or tunnel the
# pinned-TLS mobile listener over USB/emulator:
adb reverse tcp:9400 tcp:9400
# Manual host = localhost uses port 9400. It also requires a Mobile token and
# certificate fingerprint already obtained through trusted local development tooling.
```

Connection details are stored in an encrypted DataStore (Android Keystore-backed). LAN
connections require HTTPS/WSS and accept only the exact leaf certificate fingerprint from
the v3 pairing payload. HTTP and WebSocket requests send the Mobile token in the encrypted
`Authorization` header, never in the URL. Legacy v1 plaintext or split-token profiles route back
to pairing; scan a current Mission Control QR instead. Relay profiles use the public relay's normal
TLS validation.

## Roadmap

- **Push notifications**, deploy/connectors/projects parity, and instrumented UI tests.
