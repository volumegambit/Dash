#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$ROOT_DIR/apps/website/app/icon.svg"
OUTPUT="$ROOT_DIR/ios/Dash/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
RASTERIZER="$ROOT_DIR/ios/scripts/generate-app-icon.swift"
SOURCE_SHA256='44fa638df2fa6b144c72c437fc023232da4e6adc18708dffc54a46ac9d71aac7'
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

printf '%s  %s\n' "$SOURCE_SHA256" "$SOURCE" | shasum -a 256 --check
mkdir -p "$(dirname "$OUTPUT")"
xcrun swiftc -swift-version 6 -O "$RASTERIZER" -o "$TMP_DIR/generate-app-icon"
"$TMP_DIR/generate-app-icon" "$SOURCE" "$OUTPUT"

[[ "$(sips -g pixelWidth "$OUTPUT" | awk '/pixelWidth:/ {print $2}')" == '1024' ]]
[[ "$(sips -g pixelHeight "$OUTPUT" | awk '/pixelHeight:/ {print $2}')" == '1024' ]]
[[ "$(sips -g hasAlpha "$OUTPUT" | awk '/hasAlpha:/ {print $2}')" == 'no' ]]
