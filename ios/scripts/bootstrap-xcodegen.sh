#!/usr/bin/env bash
set -euo pipefail

VERSION='2.45.4'
SHA256='090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef'
BINARY_SHA256='6aa2b4da95304b343bea12890c59f9655aa428c08b351d57d592cfab4e88a9f1'
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$IOS_DIR/.tools/xcodegen/$VERSION"
ARCHIVE="$IOS_DIR/.tools/downloads/xcodegen-$VERSION.zip"
BINARY="$TOOLS_DIR/xcodegen/bin/xcodegen"
PRIMARY_URL="https://github.com/yonaskolb/XcodeGen/releases/download/$VERSION/xcodegen.zip"
FALLBACK_URL='https://api.github.com/repos/yonaskolb/XcodeGen/releases/assets/396214908'

DOWNLOAD_DIR=''
EXTRACT_DIR=''
BACKUP_DIR=''

cleanup() {
  if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
    if [[ ! -e "$TOOLS_DIR/xcodegen" ]]; then
      mv "$BACKUP_DIR" "$TOOLS_DIR/xcodegen"
    else
      rm -rf "$BACKUP_DIR"
    fi
  fi
  [[ -z "$DOWNLOAD_DIR" ]] || rm -rf "$DOWNLOAD_DIR"
  [[ -z "$EXTRACT_DIR" ]] || rm -rf "$EXTRACT_DIR"
}
trap cleanup EXIT

checksum_matches() {
  local expected="$1"
  local path="$2"
  [[ -f "$path" ]] &&
    printf '%s  %s\n' "$expected" "$path" | shasum -a 256 --check >/dev/null 2>&1
}

binary_is_authenticated() {
  [[ -x "$BINARY" ]] &&
    checksum_matches "$BINARY_SHA256" "$BINARY" &&
    [[ "$("$BINARY" --version)" == "Version: $VERSION" ]]
}

if ! binary_is_authenticated; then
  mkdir -p "$(dirname "$ARCHIVE")" "$TOOLS_DIR"
  if ! checksum_matches "$SHA256" "$ARCHIVE"; then
    DOWNLOAD_DIR="$(mktemp -d "$(dirname "$ARCHIVE")/.xcodegen-download.XXXXXX")"
    DOWNLOAD_ARCHIVE="$DOWNLOAD_DIR/xcodegen-$VERSION.zip"
    if ! curl --fail --location --silent --show-error \
      "$PRIMARY_URL" --output "$DOWNLOAD_ARCHIVE"; then
      printf 'Direct XcodeGen download failed; retrying through the GitHub Releases API.\n' >&2
      curl --fail --location --silent --show-error \
        --header 'Accept: application/octet-stream' \
        --header 'X-GitHub-Api-Version: 2022-11-28' \
        "$FALLBACK_URL" --output "$DOWNLOAD_ARCHIVE"
    fi
    if ! checksum_matches "$SHA256" "$DOWNLOAD_ARCHIVE"; then
      printf 'Downloaded XcodeGen archive failed SHA-256 verification.\n' >&2
      exit 1
    fi
    mv "$DOWNLOAD_ARCHIVE" "$ARCHIVE"
  fi

  EXTRACT_DIR="$(mktemp -d "$TOOLS_DIR/.xcodegen-extract.XXXXXX")"
  ditto -x -k "$ARCHIVE" "$EXTRACT_DIR"
  CANDIDATE="$EXTRACT_DIR/xcodegen/bin/xcodegen"
  chmod +x "$CANDIDATE"
  if ! checksum_matches "$BINARY_SHA256" "$CANDIDATE" ||
    [[ "$("$CANDIDATE" --version)" != "Version: $VERSION" ]]; then
    printf 'Extracted XcodeGen binary failed authentication.\n' >&2
    exit 1
  fi

  if [[ -e "$TOOLS_DIR/xcodegen" ]]; then
    BACKUP_DIR="$TOOLS_DIR/.xcodegen-backup.$$"
    mv "$TOOLS_DIR/xcodegen" "$BACKUP_DIR"
  fi
  if ! mv "$EXTRACT_DIR/xcodegen" "$TOOLS_DIR/xcodegen"; then
    printf 'Could not install authenticated XcodeGen binary.\n' >&2
    exit 1
  fi
  [[ -z "$BACKUP_DIR" ]] || rm -rf "$BACKUP_DIR"
  BACKUP_DIR=''
fi

[[ "$("$BINARY" --version)" == "Version: $VERSION" ]]
printf '%s\n' "$BINARY"
