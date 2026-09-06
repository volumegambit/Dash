#!/usr/bin/env bash
set -euo pipefail

ANDROID_ENV_FILE="${ANDROID_ENV_FILE:-/Users/gerry/android-sdk/env.sh}"
source "$ANDROID_ENV_FILE"
SDKMANAGER="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/avdmanager"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
EMULATOR="$ANDROID_SDK_ROOT/emulator/emulator"
SERIAL="emulator-5556"
IMAGE="system-images;android-26;google_apis;arm64-v8a"

"$SDKMANAGER" 'cmdline-tools;latest' 'platform-tools' 'emulator' 'platforms;android-36' \
  'build-tools;36.0.0' "$IMAGE"
if ! "$AVDMANAGER" list avd | grep -q 'Name: dash-api26'; then
  printf 'no\n' | "$AVDMANAGER" create avd --name dash-api26 --package "$IMAGE" --device 'pixel_2'
fi
if ! "$ADB" -s "$SERIAL" get-state >/dev/null 2>&1; then
  mkdir -p build/emulator
  nohup "$EMULATOR" -avd dash-api26 -port 5556 -no-window -no-audio \
    -no-snapshot-save -gpu swiftshader_indirect >build/emulator/api26.log 2>&1 &
fi
for _attempt in $(seq 1 120); do
  if [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = '1' ]; then
    [ "$("$ADB" -s "$SERIAL" shell getprop ro.build.version.sdk | tr -d '\r')" = '26' ]
    exit 0
  fi
  sleep 1
done
echo 'API 26 emulator did not boot; see android/build/emulator/api26.log' >&2
exit 1
