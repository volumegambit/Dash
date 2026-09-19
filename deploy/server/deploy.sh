#!/usr/bin/env bash
# Deploy (or roll back) the hosted relay + control plane on this host.
#
#   ./deploy.sh ghcr.io/volumegambit/dash-server:sha-abc1234
#
# Records the image in .env, pulls it, restarts the stack, waits for the
# containers' own healthchecks, then runs smoke.sh against the public URLs in
# .env. Prints the previously running image — re-run with it to roll back.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${1:?usage: deploy.sh <image>}"
[ -f .env ] || { echo ".env is missing — copy .env.example and fill it in" >&2; exit 1; }

PREVIOUS="$(grep -E '^DASH_SERVER_IMAGE=' .env | cut -d= -f2- || true)"
if grep -qE '^DASH_SERVER_IMAGE=' .env; then
  sed -i.bak -E "s#^DASH_SERVER_IMAGE=.*#DASH_SERVER_IMAGE=${IMAGE}#" .env && rm -f .env.bak
else
  printf 'DASH_SERVER_IMAGE=%s\n' "$IMAGE" >> .env
fi

echo "==> pulling $IMAGE"
docker compose pull --quiet
echo "==> starting stack"
docker compose up -d --remove-orphans --wait --wait-timeout 180

# shellcheck disable=SC1091
set -a; . ./.env; set +a
if ./smoke.sh "$CP_PUBLIC_URL" "$RELAY_PROBE_URL"; then
  echo "==> deployed $IMAGE (previous: ${PREVIOUS:-none})"
else
  echo "==> SMOKE FAILED for $IMAGE" >&2
  [ -n "$PREVIOUS" ] && echo "    roll back with: ./deploy.sh $PREVIOUS" >&2
  exit 1
fi
