#!/usr/bin/env bash
set -euo pipefail

VERSION='2.45.4'
SHA256='090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef'
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$IOS_DIR/.tools/xcodegen/$VERSION"
ARCHIVE="$IOS_DIR/.tools/downloads/xcodegen-$VERSION.zip"
BINARY="$TOOLS_DIR/xcodegen/bin/xcodegen"
PRIMARY_URL="https://github.com/yonaskolb/XcodeGen/releases/download/$VERSION/xcodegen.zip"
FALLBACK_URL='https://api.github.com/repos/yonaskolb/XcodeGen/releases/assets/396214908'

if [[ ! -x "$BINARY" ]]; then
  mkdir -p "$(dirname "$ARCHIVE")" "$TOOLS_DIR"
  if ! curl --fail --location --silent --show-error "$PRIMARY_URL" --output "$ARCHIVE"; then
    printf 'Direct XcodeGen download failed; retrying through the GitHub Releases API.\n' >&2
    curl --fail --location --silent --show-error \
      --header 'Accept: application/octet-stream' \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      "$FALLBACK_URL" --output "$ARCHIVE"
  fi
  printf '%s  %s\n' "$SHA256" "$ARCHIVE" | shasum -a 256 --check
  rm -rf "$TOOLS_DIR/xcodegen"
  ditto -x -k "$ARCHIVE" "$TOOLS_DIR"
  chmod +x "$BINARY"
fi

[[ "$($BINARY --version)" == "Version: $VERSION" ]]
printf '%s\n' "$BINARY"
