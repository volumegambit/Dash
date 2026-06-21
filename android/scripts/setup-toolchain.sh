#!/usr/bin/env bash
# Idempotently installs a JDK 17 + Android SDK toolchain sufficient to compile
# the Dash Android app and run its JVM unit tests (no emulator required).
#
# Usage:  ./android/scripts/setup-toolchain.sh
# After it runs, source the generated env file before building:
#   source "$HOME/android-sdk/env.sh"
#   cd android && ./gradlew test
set -uo pipefail

CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip"
ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"

echo "==> JDK 17 (Android Gradle Plugin 8.x requirement)"
if ! brew list openjdk@17 >/dev/null 2>&1; then
  brew install openjdk@17
fi
JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
java -version

echo "==> Android SDK command-line tools"
mkdir -p "$ANDROID_HOME/cmdline-tools"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  TMP="$(mktemp -d)"
  curl -sSL -o "$TMP/cmdtools.zip" "$CMDLINE_TOOLS_URL"
  unzip -q "$TMP/cmdtools.zip" -d "$TMP"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$TMP/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

echo "==> SDK packages (android-34, build-tools 34, platform-tools)"
yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0"

echo "==> Writing $ANDROID_HOME/env.sh"
cat > "$ANDROID_HOME/env.sh" <<EOF
export JAVA_HOME="$JAVA_HOME"
export ANDROID_HOME="$ANDROID_HOME"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$PATH"
EOF

echo "==> Writing android/local.properties"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "sdk.dir=$ANDROID_HOME" > "$SCRIPT_DIR/../local.properties"

echo "Done. Next: source \"$ANDROID_HOME/env.sh\" && (cd android && ./gradlew test)"
