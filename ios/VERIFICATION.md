# Dash mobile balanced v1 verification

## Result

Local automated release gates pass for the native iOS and Android clients, the shared gateway
conversation authority, Mission Control synchronization, and the hosted relay boundary. The
balanced-v1 implementation snapshot is branch `feat/ios-conversation-sync` at commit
`b67967b63097fc856bb6de21dd23cdd8bcd3600a`, verified on 2026-07-15. Subsequent changes are
CI and test-harness hardening, reverified locally on 2026-07-16.

The pull request's pinned Xcode 16.3 / iOS 18.4 live-gateway job remains the authoritative hosted
gate. Physical-device QA is also still required before calling the iOS build production-ready.

## Local iOS environment

- macOS 26.5.2 (25F84), Xcode 26.6 (17F113), and Swift 6.3.3.
- iOS 26.5 simulator runtime (23F77) with iOS 26.5 SDK (23F81a).
- iPhone 17 Pro simulator: `5FDDE3B1-B6F6-448B-9959-EF56292D8E51`.
- iPad Pro 13-inch (M5) simulator: `B6F9A163-7775-4EEB-A8C2-D7C78401EC50`.

## iOS simulator coverage

- Full `Dash` scheme on iPhone: 570 logical tests / 609 parameterized executions, 0 failures,
  0 skips. Evidence: `/tmp/dash-ios-final-unit-contract-iphone-20260715-a.xcresult`.
- Full `Dash` scheme on iPad: 570 logical tests / 609 parameterized executions, 0 failures,
  0 skips. Evidence: `/tmp/dash-ios-final-unit-contract-ipad-20260715-a.xcresult`.
- iPhone UI suite: 23 executions, 21 passed, 2 intended iPad-only skips, 0 failures. Evidence:
  `/tmp/dash-ios-full-iphone-ui-20260715T173829Z.xcresult`.
- iPad UI suite: 23 executions, 22 passed, 1 intended iPhone-only skip, 0 failures. Evidence:
  `/tmp/dash-ios-full-ipad-ui-20260715T175150Z.xcresult`.
- Dark appearance with increased contrast: 1 passed, 0 failures. Simulator appearance and
  contrast were restored after the run. Evidence:
  `/tmp/dash-ios-dark-contrast-core-20260715T180819Z.xcresult`.
- Focused UI-scenario support suite: 11 passed, 0 failures. Evidence:
  `/tmp/dash-ios-uitest-scenario-support-20260716-01.xcresult`.
- Integration-support scenarios: 9 passed, 0 failures using isolated DerivedData. Evidence:
  `/tmp/dash-ios-final-integration-support-iphone-20260715-b.xcresult`.

The first integration-support attempt used shared DerivedData while another Xcode test run was
active, and Xcode lost the test bundle before executing a test. The isolated rerun above is the
authoritative result.

The 2026-07-16 UI matrix ran once without retry configuration. Its recovery fixture deliberately
overflows the iPhone composer, and text replacement uses the English native edit menu so a partial
caret-position delete cannot pass locally while failing on the hosted runner.

## iOS release artifacts and configuration

- Generic Release builds passed for the iOS Simulator (`arm64` and `x86_64`) and unsigned iOS
  device (`arm64`).
- Both Release products report version `0.2.0` and build `1`.
- The source and embedded privacy manifests linted and matched byte-for-byte. Both built
  `Info.plist` files contain no App Transport Security exceptions.
- The deterministic 1024x1024 app icon matched the checked-in icon byte-for-byte and has no alpha.
- `ios/scripts/check-project.sh` regenerated `Dash.xcodeproj` with no committed-project drift.
- The generic simulator product is under `/tmp/dash-ios-final-release-sim-20260715-a` and the
  unsigned device product is under `/tmp/dash-ios-final-release-device-20260715-a`.

## Shared runtime and Android coverage

- Repository lint passed for 923 files.
- All 17 root Node workspaces and the separate Mission Control production build passed.
- Vitest passed 250 files and 3,411 tests.
- The mobile contract passed all 11 fixtures. The canonical desktop/iOS transcript, conflict,
  cancel, and archive end-to-end checks passed.
- Model-catalog freshness passed.
- Android `test assembleDebug` completed 424 tasks. All 21 XML test suites and 172 test
  executions passed with no failures, errors, or skips.
- Android debug APK SHA-256:
  `81f38519bcb8ca155e01ca2bfeb98865079dacd950eadf399d748a5770fe669f`.

## Hosted live-gateway gate

The pinned GitHub Actions environment uses Xcode 16.3 and iOS 18.4 for six live cases: HTTP/SSE,
detach/replay/resume, cold bootstrap/restart, question/answer, explicit cancel, and
background-detach/foreground reconciliation. Local setup intentionally refuses Xcode 26.6 because
it cannot prove the pinned CI toolchain. The pull request's hosted iOS check must be green before
merge.

## Physical-device work still required

The physical checklist remains 0 of 19 complete. Gerry's iPhone 17 Pro was unavailable during this
verification run, and no physical iPad was available. Keep the matching cases unchecked in
[`QA_CHECKLIST.md`](QA_CHECKLIST.md) until evidence is captured on real hardware:

- Camera permission and QR scanning on a real camera.
- Pinned LAN HTTPS/WSS over real Wi-Fi, Local Network permission, and firewall conditions.
- Relay HTTPS/WSS over cellular data.
- Keychain persistence, revocation, uninstall/reinstall, and Disconnect & Forget lifecycle.
- Background suspension and foreground replay while a real stream is active.
- VoiceOver, hardware keyboard, Dynamic Type, Reduce Motion, and iPad multitasking behavior.

Record device model, OS version, build commit, tester, date, and secret-free evidence in the
physical-device checklist for every completed case.
