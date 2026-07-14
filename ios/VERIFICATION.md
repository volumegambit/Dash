# Dash mobile balanced v1 verification

## Result

The automated balanced v1 release gates pass for the native iOS and Android clients, the shared
gateway conversation authority, and Mission Control synchronization. Physical-device QA is still
required before calling the iOS build production-ready.

## iOS simulator coverage

- iPhone 16 Pro, iOS 18.4:
  - 23 contract and app-test suites: 410 logical tests, 0 failures, 0 skips.
  - 20 UI tests: 18 passed, 2 intended iPad-only skips, 0 failures.
- iPad Pro, iOS 18.4:
  - 23 contract and app-test suites: 410 logical tests / 447 parameterized executions, 0 failures,
    0 skips.
  - 20 UI tests: 19 passed, 1 intended iPhone-only skip, 0 failures.
- Six live pinned-gateway cases passed: HTTP/SSE, detach/replay/resume, cold bootstrap/restart,
  question/answer, explicit cancel, and background-detach/foreground reconciliation.
- Generic Release builds passed for the iOS Simulator (`arm64` and `x86_64`) and unsigned iOS
  device (`arm64`).
- The source and embedded privacy manifests linted and matched byte-for-byte. Both built
  `Info.plist` files contain no App Transport Security exceptions.
- The generated 1024x1024 app icon matched the checked-in icon byte-for-byte and has no alpha.

## Shared runtime and Android coverage

- Repository lint passed for 921 files.
- All 18 Node package/application builds and the Mission Control production build passed.
- Vitest passed 249 files and 3,365 tests.
- The mobile contract passed all 11 fixtures and the desktop/iOS canonical transcript end-to-end
  check passed.
- Model-catalog freshness passed.
- Android Gradle verification completed 374 tasks. All 21 test suites and 168 test executions
  passed with no failures, errors, or skips, and `app-debug.apk` was assembled.

## Physical-device work still required

The simulator cannot prove the following. Keep the matching cases unchecked in
[`QA_CHECKLIST.md`](QA_CHECKLIST.md) until evidence is captured on real hardware:

- Camera permission and QR scanning on a real camera.
- Pinned LAN HTTPS/WSS over real Wi-Fi, Local Network permission, and firewall conditions.
- Relay HTTPS/WSS over cellular data.
- Keychain persistence, revocation, uninstall/reinstall, and Disconnect & Forget lifecycle.
- Background suspension and foreground replay while a real stream is active.
- VoiceOver, hardware keyboard, Dynamic Type, Reduce Motion, and iPad multitasking behavior.

Record device model, OS version, build commit, tester, date, and secret-free evidence in the
physical-device checklist for every completed case.
