#!/usr/bin/env bash
set -euo pipefail

VERSION='2.45.4'
SHA256='090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef'
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$IOS_DIR/.tools/xcodegen/$VERSION"
ARCHIVE="$IOS_DIR/.tools/downloads/xcodegen-$VERSION.zip"
BINARY="$TOOLS_DIR/xcodegen/bin/xcodegen"

if [[ ! -x "$BINARY" ]]; then
  mkdir -p "$(dirname "$ARCHIVE")" "$TOOLS_DIR"
  curl --fail --location --silent --show-error \
    "https://github.com/yonaskolb/XcodeGen/releases/download/$VERSION/xcodegen.zip" \
    --output "$ARCHIVE"
  printf '%s  %s\n' "$SHA256" "$ARCHIVE" | shasum -a 256 --check
  rm -rf "$TOOLS_DIR/xcodegen"
  ditto -x -k "$ARCHIVE" "$TOOLS_DIR"
  chmod +x "$BINARY"
fi

[[ "$($BINARY --version)" == "Version: $VERSION" ]]
printf '%s\n' "$BINARY"
