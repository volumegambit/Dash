#!/bin/bash
# Capture every reachable Dash iOS surface to PNGs, with no test runner.
#
#   ios/scripts/capture-surfaces.sh                     iPhone sim, ./build/captures
#   ios/scripts/capture-surfaces.sh --ipad              iPad sim
#   ios/scripts/capture-surfaces.sh --out /tmp/shots    somewhere else
#   ios/scripts/capture-surfaces.sh --no-build          reuse the last build
#
# Why this exists: most of this app's screens could not be looked at.
# `simctl` has no tap command, `devicectl` has no screenshot subcommand, the
# `dash://` scheme only handles `oauth-callback`, and an XCUITest that adds
# `XCTAttachment` screenshots aborts under Xcode 26. Three screens were
# redesigned on 2026-09-05 and shipped without anyone seeing them, and two
# defects reported from a photo of a physical iPad could not be reproduced
# locally. The debug-only launch options this drives (`DASH_UI_TEST_TAB`,
# `DASH_UI_TEST_CONVERSATION`) close that gap.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID="app.dash.ios"
SCHEME="Dash"
DERIVED="build/CaptureDerivedData"
OUT="build/captures"
BUILD=1

# Hand-made iOS 26.5 sims. `ensure-simulators.sh` refuses Xcode 26, so these
# are passed as UDIDs rather than resolved by name.
IPHONE_UDID="BC8AEC19-01DF-48EA-9F84-89FFA90C3A16"
IPAD_UDID="A79A9881-69C0-43AD-8528-D5AB9D3B5F58"
UDID="$IPHONE_UDID"
IDIOM="iphone"

while [ $# -gt 0 ]; do
  case "$1" in
    --ipad)     UDID="$IPAD_UDID"; IDIOM="ipad"; shift ;;
    --iphone)   UDID="$IPHONE_UDID"; IDIOM="iphone"; shift ;;
    --udid)     UDID="$2"; IDIOM="device"; shift 2 ;;
    --out)      OUT="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"

if [ "$BUILD" = 1 ]; then
  echo "==> building $SCHEME (Debug) for $IDIOM"
  xcodebuild -project Dash.xcodeproj -scheme "$SCHEME" -configuration Debug \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$DERIVED" build CODE_SIGNING_ALLOWED=NO >/dev/null
fi

APP="$DERIVED/Build/Products/Debug-iphonesimulator/Dash.app"
[ -d "$APP" ] || { echo "no app at $APP — run without --no-build" >&2; exit 1; }

xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
# Uninstall before installing, so a run can never serve a previously-installed
# binary. Cheap insurance: this script's whole value is that a capture is
# trustworthy, and a stale screenshot reports the old UI as the new one.
#
# Safe to uninstall: every surface below launches with its own
# DASH_UI_TEST_DATA_IDENTIFIER, so there is no app data worth preserving.
#
# NOTE on `--no-build`: this script `cd`s to `ios/`, so `$DERIVED` is
# `ios/build/CaptureDerivedData`. A build run by hand from the repo root with
# `-derivedDataPath build/...` lands somewhere else entirely, and `--no-build`
# will then capture whatever this script last built. Three "the fix didn't
# work" rounds were spent on that. Use `--no-build` only to re-capture a build
# this script produced.
xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP"

# name|scenario|extra env
# Only surfaces a launch option can actually reach. `approve-device` was here
# and produced a screenshot of the conversation list under that name — the
# view is a SHEET presented from Settings, and a scenario alone does not open
# it. A capture whose filename lies is worse than a missing one. Sheets and
# pushed detail views (agent detail, agent editor, image viewer) need a route
# option before they can join this list.
SURFACES=(
  "conversations|paired-online|DASH_UI_TEST_TAB=conversations"
  "conversations-offline|paired-offline|DASH_UI_TEST_TAB=conversations"
  "agents|paired-online|DASH_UI_TEST_TAB=agents"
  "settings|paired-online|DASH_UI_TEST_TAB=settings"
  "chat|paired-online|DASH_UI_TEST_CONVERSATION=shared-plan"
  "signin|signed-out|"
  "gateway-picker|account-picker|"
  "recovery|pending-recovery|DASH_UI_TEST_TAB=conversations"
)

for entry in "${SURFACES[@]}"; do
  name="${entry%%|*}"; rest="${entry#*|}"
  scenario="${rest%%|*}"; extra="${rest#*|}"

  xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true

  env_args=(
    "SIMCTL_CHILD_DASH_UI_TEST_SCENARIO=$scenario"
    "SIMCTL_CHILD_DASH_UI_TEST_DATA_IDENTIFIER=capture-$name"
  )
  if [ -n "$extra" ]; then env_args+=("SIMCTL_CHILD_$extra"); fi

  if ! env "${env_args[@]}" xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null 2>&1; then
    echo "  !! $name — launch failed (scenario '$scenario' may not exist)"
    continue
  fi

  # The app has to reach first paint; there is no readiness signal to wait on.
  sleep 6
  xcrun simctl io "$UDID" screenshot "$OUT/$IDIOM-$name.png" >/dev/null 2>&1
  echo "  -> $OUT/$IDIOM-$name.png"
done

xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
echo "==> captured $(ls -1 "$OUT"/$IDIOM-*.png 2>/dev/null | wc -l | tr -d ' ') surfaces to $OUT"
