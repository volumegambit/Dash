#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VERIFY="$ROOT_DIR/ios/scripts/verify-built-app.sh"
SOURCE_MANIFEST="$ROOT_DIR/ios/Dash/Resources/PrivacyInfo.xcprivacy"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

make_bundle() {
  local bundle="$1"
  mkdir -p "$bundle"
  cp "$SOURCE_MANIFEST" "$bundle/PrivacyInfo.xcprivacy"
  plutil -create xml1 "$bundle/Info.plist"
}

GOOD_APP="$TMP_DIR/Good.app"
make_bundle "$GOOD_APP"
"$VERIFY" "$GOOD_APP"

MISMATCHED_APP="$TMP_DIR/Mismatched.app"
make_bundle "$MISMATCHED_APP"
printf '\n' >> "$MISMATCHED_APP/PrivacyInfo.xcprivacy"
if "$VERIFY" "$MISMATCHED_APP" >/dev/null 2>&1; then
  echo 'expected a mismatched embedded privacy manifest to fail verification' >&2
  exit 1
fi

ATS_APP="$TMP_DIR/ATS.app"
make_bundle "$ATS_APP"
plutil -insert NSAppTransportSecurity -dictionary "$ATS_APP/Info.plist"
if "$VERIFY" "$ATS_APP" >/dev/null 2>&1; then
  echo 'expected an App Transport Security exception dictionary to fail verification' >&2
  exit 1
fi

if "$VERIFY" "$TMP_DIR/Missing.app" >/dev/null 2>&1; then
  echo 'expected a missing app bundle to fail verification' >&2
  exit 1
fi

echo 'verify-built-app tests passed'
