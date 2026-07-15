#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo 'usage: verify-built-app.sh <Dash.app>' >&2
  exit 64
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_BUNDLE="$1"
SOURCE_MANIFEST="$ROOT_DIR/ios/Dash/Resources/PrivacyInfo.xcprivacy"
EMBEDDED_MANIFEST="$APP_BUNDLE/PrivacyInfo.xcprivacy"
BUILT_INFO_PLIST="$APP_BUNDLE/Info.plist"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "built app bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

for required_file in "$SOURCE_MANIFEST" "$EMBEDDED_MANIFEST" "$BUILT_INFO_PLIST"; do
  if [[ ! -f "$required_file" ]]; then
    echo "required app metadata not found: $required_file" >&2
    exit 1
  fi
  plutil -lint "$required_file" >/dev/null
done

if ! cmp -s "$SOURCE_MANIFEST" "$EMBEDDED_MANIFEST"; then
  echo 'embedded privacy manifest differs from the reviewed source manifest' >&2
  exit 1
fi

if plutil -extract NSAppTransportSecurity xml1 -o - "$BUILT_INFO_PLIST" >/dev/null 2>&1; then
  echo 'built Info.plist must not contain App Transport Security exceptions' >&2
  exit 1
fi

echo "verified built app privacy metadata: $APP_BUNDLE"
