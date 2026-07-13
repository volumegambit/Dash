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

device_udid() {
  local name="$1"
  local type="$2"
  xcrun simctl list devices available --json | xcrun swift -e '
    import Darwin
    import Foundation

    struct DeviceList: Decodable {
      let devices: [String: [Device]]
    }

    struct Device: Decodable {
      let name: String
      let udid: String
      let deviceTypeIdentifier: String
      let isAvailable: Bool?
    }

    guard CommandLine.arguments.count == 4 else { exit(64) }
    let runtime = CommandLine.arguments[1]
    let name = CommandLine.arguments[2]
    let type = CommandLine.arguments[3]
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let list = try JSONDecoder().decode(DeviceList.self, from: data)
    guard let device = list.devices[runtime]?.first(where: {
      $0.name == name && $0.deviceTypeIdentifier == type && $0.isAvailable != false
    }) else {
      exit(1)
    }
    print(device.udid)
  ' "$RUNTIME_ID" "$name" "$type"
}

ensure_device() {
  local name="$1"
  local type="$2"
  if ! device_udid "$name" "$type" >/dev/null; then
    xcrun simctl create "$name" "$type" "$RUNTIME_ID" >/dev/null
  fi
  device_udid "$name" "$type" >/dev/null
}

ensure_device "$IPHONE_NAME" "$IPHONE_TYPE"
ensure_device "$IPAD_NAME" "$IPAD_TYPE"

case "${1:-}" in
  --iphone-udid) device_udid "$IPHONE_NAME" "$IPHONE_TYPE"; exit 0 ;;
  --ipad-udid) device_udid "$IPAD_NAME" "$IPAD_TYPE"; exit 0 ;;
  '') ;;
  *) printf 'Usage: %s [--iphone-udid|--ipad-udid]\n' "$0" >&2; exit 64 ;;
esac

printf 'Ready: %s and %s on %s\n' "$IPHONE_NAME" "$IPAD_NAME" "$RUNTIME_NAME"
