#!/usr/bin/env bash
# Post-deploy smoke test for the hosted relay + control plane.
#
#   ./smoke.sh https://api.stg.relay.example.com https://smoke.stg.relay.example.com
#
# 1. The control plane answers /health.
# 2. The control plane REFUSES an unauthenticated /v1/gateways (401). This is the
#    regression test for the 2026-09-05 audit finding: a stub authenticator or
#    header-stamping shim in front of the CP turns this into a 200.
# 3. The relay answers on its wildcard zone: 502 when no gateway has that
#    subdomain, 401 when one has and no pairing credential was sent. Either
#    proves TLS + routing for `*.zone` work end to end.
set -uo pipefail
CP="${1:?usage: smoke.sh <cp-url> <relay-probe-url>}"
RELAY="${2:?usage: smoke.sh <cp-url> <relay-probe-url>}"
failed=0

check() {
  local label="$1" want="$2" url="$3" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)"
  if [[ " $want " == *" $code "* ]]; then
    echo "ok    $label ($code)"
  else
    echo "FAIL  $label: got $code, want one of [$want] — $url"
    failed=1
  fi
}

check "control plane health"        "200"     "$CP/health"
check "control plane requires auth" "401"     "$CP/v1/gateways"
check "relay wildcard route"        "401 502" "$RELAY/mobile/v1/health"
exit $failed
