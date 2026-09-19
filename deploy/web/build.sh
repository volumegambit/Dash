#!/usr/bin/env bash
# Build apps/web for one environment and emit the Cloudflare Pages _headers file.
#
#   VITE_CLERK_PUBLISHABLE_KEY=pk_... VITE_CONTROL_PLANE_URL=https://api... \
#   VITE_RELAY_DOMAIN=stg.relay.example.com deploy/web/build.sh
#
# Vite bakes the three VITE_* values into the bundle and its CSP, so a bundle
# is bound to one environment — build per environment, never promote.
# Requires the workspace packages to be built first (`npm run build`) because
# apps/web typechecks against @dash/mobile-contract.
set -euo pipefail
cd "$(dirname "$0")/../.."

for name in VITE_CLERK_PUBLISHABLE_KEY VITE_CONTROL_PLANE_URL VITE_RELAY_DOMAIN; do
  [ -n "${!name:-}" ] || { echo "$name is required" >&2; exit 1; }
done

npm run web:build --silent
node scripts/web-csp-headers.mjs apps/web/dist
echo "built apps/web/dist for ${VITE_CONTROL_PLANE_URL} (relay ${VITE_RELAY_DOMAIN})"
