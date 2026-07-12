#!/usr/bin/env bash
set -euo pipefail

RUNTIME_VERSION='18.4'
RUNTIME_NAME="iOS $RUNTIME_VERSION"
RUNTIME_ID='com.apple.CoreSimulator.SimRuntime.iOS-18-4'
IPHONE_NAME='iPhone 16 Pro'
IPHONE_TYPE='com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro'
IPAD_NAME='iPad Pro 13-inch (M4)'
IPAD_TYPE='com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB'

if [[ "$(xcodebuild -version | sed -n '1p')" != 'Xcode 16.3' ]]; then
  printf 'Expected Xcode 16.3 before simulator setup.\n' >&2
  exit 1
fi

if ! xcrun simctl list runtimes | grep -F "$RUNTIME_ID" | grep -Fqv 'unavailable'; then
  xcodebuild -downloadPlatform iOS -buildVersion "$RUNTIME_VERSION"
fi
xcrun simctl list runtimes | grep -F "$RUNTIME_ID" | grep -Fqv 'unavailable'

has_device() {
  local name="$1"
  xcrun simctl list devices available | awk -v runtime="-- $RUNTIME_NAME --" -v name="$name" '
    $0 == runtime { inside = 1; next }
    /^-- / { inside = 0 }
    inside && index($0, name " (") { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

ensure_device() {
  local name="$1"
  local type="$2"
  if ! has_device "$name"; then
    xcrun simctl create "$name" "$type" "$RUNTIME_ID" >/dev/null
  fi
  has_device "$name"
}

device_udid() {
  local name="$1"
  xcrun simctl list devices available | awk -v runtime="-- $RUNTIME_NAME --" -v name="$name" '
    $0 == runtime { inside = 1; next }
    /^-- / { inside = 0 }
    inside && index($0, name " (") { print; exit }
  ' | grep -Eo '[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}'
}

ensure_device "$IPHONE_NAME" "$IPHONE_TYPE"
ensure_device "$IPAD_NAME" "$IPAD_TYPE"

case "${1:-}" in
  --iphone-udid) device_udid "$IPHONE_NAME"; exit 0 ;;
  --ipad-udid) device_udid "$IPAD_NAME"; exit 0 ;;
  '') ;;
  *) printf 'Usage: %s [--iphone-udid|--ipad-udid]\n' "$0" >&2; exit 64 ;;
esac

printf 'Ready: %s and %s on %s\n' "$IPHONE_NAME" "$IPAD_NAME" "$RUNTIME_NAME"
