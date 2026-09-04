#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

IOS_DIR="$TMP_DIR/ios"
MOCK_BIN="$TMP_DIR/mock-bin"
CHECKSUM_LOG="$TMP_DIR/checksums.log"
EXTRACT_LOG="$TMP_DIR/extract.log"
CURL_LOG="$TMP_DIR/curl.log"

mkdir -p "$IOS_DIR/scripts" "$IOS_DIR/.tools/downloads" \
  "$IOS_DIR/.tools/xcodegen/2.45.4/xcodegen/bin" "$MOCK_BIN"
cp "$ROOT_DIR/ios/scripts/bootstrap-xcodegen.sh" "$IOS_DIR/scripts/bootstrap-xcodegen.sh"
printf 'verified-archive\n' >"$IOS_DIR/.tools/downloads/xcodegen-2.45.4.zip"

cat >"$IOS_DIR/.tools/xcodegen/2.45.4/xcodegen/bin/xcodegen" <<'EOF'
#!/usr/bin/env bash
printf 'Version: 2.45.4\n'
EOF
chmod +x "$IOS_DIR/.tools/xcodegen/2.45.4/xcodegen/bin/xcodegen"

cat >"$MOCK_BIN/shasum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

read -r expected path
case "$path" in
  */xcodegen-2.45.4.zip)
    printf 'archive %s\n' "$expected" >>"$CHECKSUM_LOG"
    [[ "$expected" == '090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef' ]]
    grep -Fqx 'verified-archive' "$path"
    ;;
  */xcodegen/bin/xcodegen)
    printf 'binary %s\n' "$expected" >>"$CHECKSUM_LOG"
    [[ "$expected" == '6aa2b4da95304b343bea12890c59f9655aa428c08b351d57d592cfab4e88a9f1' ]]
    grep -Fq 'RECOVERED_BINARY=1' "$path"
    ;;
  *)
    printf 'unexpected checksum path: %s\n' "$path" >&2
    exit 2
    ;;
esac
printf '%s: OK\n' "$path"
EOF
chmod +x "$MOCK_BIN/shasum"

cat >"$MOCK_BIN/ditto" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

destination="${!#}"
printf 'extract\n' >>"$EXTRACT_LOG"
mkdir -p "$destination/xcodegen/bin"
cat >"$destination/xcodegen/bin/xcodegen" <<'BINARY'
#!/usr/bin/env bash
# RECOVERED_BINARY=1
printf 'Version: 2.45.4\n'
BINARY
EOF
chmod +x "$MOCK_BIN/ditto"

cat >"$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf 'unexpected download\n' >>"$CURL_LOG"
exit 99
EOF
chmod +x "$MOCK_BIN/curl"

export CHECKSUM_LOG EXTRACT_LOG CURL_LOG
OUTPUT="$(PATH="$MOCK_BIN:/usr/bin:/bin" "$IOS_DIR/scripts/bootstrap-xcodegen.sh")"
EXPECTED_BINARY="$IOS_DIR/.tools/xcodegen/2.45.4/xcodegen/bin/xcodegen"

if [[ "$OUTPUT" != "$EXPECTED_BINARY" ]]; then
  printf 'expected binary path %s, got %s\n' "$EXPECTED_BINARY" "$OUTPUT" >&2
  exit 1
fi
if ! grep -Fq 'RECOVERED_BINARY=1' "$EXPECTED_BINARY"; then
  printf 'tampered cached binary was not replaced from the verified archive\n' >&2
  exit 1
fi
if [[ "$(grep -Fc 'binary 6aa2b4da95304b343bea12890c59f9655aa428c08b351d57d592cfab4e88a9f1' "$CHECKSUM_LOG")" -ne 2 ]]; then
  printf 'expected cached and extracted binary authentication checks\n' >&2
  exit 1
fi
grep -Fqx 'archive 090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef' \
  "$CHECKSUM_LOG"
grep -Fqx 'extract' "$EXTRACT_LOG"
if [[ -s "$CURL_LOG" ]]; then
  printf 'verified cached archive should be reused without a download\n' >&2
  exit 1
fi

printf 'PASS: cached XcodeGen binary is authenticated and safely recovered\n'
