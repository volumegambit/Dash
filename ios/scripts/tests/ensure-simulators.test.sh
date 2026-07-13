#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

IOS_DIR="$TMP_DIR/ios"
MOCK_BIN="$TMP_DIR/mock-bin"
SIM_STATE="$TMP_DIR/simulator-types"
CREATE_LOG="$TMP_DIR/create.log"

mkdir -p "$IOS_DIR/scripts" "$MOCK_BIN"
cp "$ROOT_DIR/ios/scripts/ensure-simulators.sh" "$IOS_DIR/scripts/ensure-simulators.sh"
: >"$SIM_STATE"
: >"$CREATE_LOG"

cat >"$MOCK_BIN/xcodebuild" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == '-version' ]]; then
  printf 'Xcode 16.3\nBuild version 16E140\n'
  exit 0
fi
printf 'unexpected xcodebuild call: %s\n' "$*" >&2
exit 2
EOF
chmod +x "$MOCK_BIN/xcodebuild"

cat >"$MOCK_BIN/xcrun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

IPHONE_TYPE='com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro'
IPAD_TYPE='com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB'
RUNTIME_ID='com.apple.CoreSimulator.SimRuntime.iOS-18-4'

if [[ "${1:-}" == 'swift' ]]; then
  exec /usr/bin/xcrun "$@"
fi
if [[ "${1:-}" != 'simctl' ]]; then
  printf 'unexpected xcrun call: %s\n' "$*" >&2
  exit 2
fi
if [[ "${2:-}" == 'list' && "${3:-}" == 'runtimes' ]]; then
  printf 'iOS 18.4 (18.4 - 22E238) - %s\n' "$RUNTIME_ID"
  exit 0
fi
if [[ "${2:-}" == 'list' && "${3:-}" == 'devices' && "${4:-}" == 'available' && -z "${5:-}" ]]; then
  cat <<'DEVICES'
-- iOS 18.4 --
    iPhone 16 Pro (AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA) (Shutdown)
    iPad Pro 13-inch (M4) (BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB) (Shutdown)
DEVICES
  exit 0
fi
if [[ "${2:-}" == 'list' && "${3:-}" == 'devices' && "${4:-}" == 'available' && "${5:-}" == '--json' ]]; then
  iphone=''
  ipad=''
  if grep -Fqx "$IPHONE_TYPE" "$SIM_STATE"; then
    iphone=',{"name":"iPhone 16 Pro","udid":"11111111-1111-1111-1111-111111111111","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro","isAvailable":true}'
  fi
  if grep -Fqx "$IPAD_TYPE" "$SIM_STATE"; then
    ipad=',{"name":"iPad Pro 13-inch (M4)","udid":"22222222-2222-2222-2222-222222222222","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB","isAvailable":true}'
  fi
  printf '{"devices":{"%s":[{"name":"iPhone 16 Pro","udid":"AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15","isAvailable":true},{"name":"iPad Pro 13-inch (M4)","udid":"BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-4GB","isAvailable":true}%s%s]}}\n' \
    "$RUNTIME_ID" "$iphone" "$ipad"
  exit 0
fi
if [[ "${2:-}" == 'create' ]]; then
  printf '%s|%s|%s\n' "$3" "$4" "$5" >>"$CREATE_LOG"
  printf '%s\n' "$4" >>"$SIM_STATE"
  if [[ "$4" == "$IPHONE_TYPE" ]]; then
    printf '11111111-1111-1111-1111-111111111111\n'
  else
    printf '22222222-2222-2222-2222-222222222222\n'
  fi
  exit 0
fi
printf 'unexpected simctl call: %s\n' "$*" >&2
exit 2
EOF
chmod +x "$MOCK_BIN/xcrun"

export SIM_STATE CREATE_LOG
OUTPUT="$(PATH="$MOCK_BIN:/usr/bin:/bin" "$IOS_DIR/scripts/ensure-simulators.sh" --iphone-udid)"
EXPECTED_CREATES="$(printf '%s\n%s' \
  'iPhone 16 Pro|com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro|com.apple.CoreSimulator.SimRuntime.iOS-18-4' \
  'iPad Pro 13-inch (M4)|com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB|com.apple.CoreSimulator.SimRuntime.iOS-18-4')"

if [[ "$OUTPUT" != '11111111-1111-1111-1111-111111111111' ]]; then
  printf 'expected exact-type iPhone UDID, got %s\n' "$OUTPUT" >&2
  exit 1
fi
if [[ "$(<"$CREATE_LOG")" != "$EXPECTED_CREATES" ]]; then
  printf 'same-name devices with wrong types were incorrectly accepted\n' >&2
  printf 'create log:\n%s\n' "$(<"$CREATE_LOG")" >&2
  exit 1
fi

printf 'PASS: simulator preflight requires exact device type identifiers\n'
