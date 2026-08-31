#!/bin/bash
# Build Dash iOS and install it on a paired iPhone — over Wi-Fi, no cable needed.
#
#   ios/scripts/deploy-device.sh              build, install, launch once
#   ios/scripts/deploy-device.sh --watch      redeploy every time sources change
#   ios/scripts/deploy-device.sh --no-launch  install only, don't foreground the app
#   ios/scripts/deploy-device.sh --list       show paired devices and exit
#
# Env:
#   DASH_IOS_DEVICE  CoreDevice identifier (default: the only paired iOS device)
#   DASH_IOS_CONFIG  Debug (default) or Release
#   DASH_IOS_WAIT    seconds to wait for the phone to appear (default 120)
#
# Signing: uses your Xcode-signed-in Apple ID. If ~/.dash-ios-deploy.env exists
# (ASC_KEY_PATH / ASC_KEY_ID / ASC_ISSUER_ID — same file deploy-testflight.sh
# reads) it signs headlessly with that App Store Connect key instead.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID="app.dash.ios"
SCHEME="Dash"
CONFIG="${DASH_IOS_CONFIG:-Debug}"
DERIVED="build/DerivedData"
WAIT_SECS="${DASH_IOS_WAIT:-120}"

LAUNCH=1
WATCH=0
for arg in "$@"; do
  case "$arg" in
    --watch)     WATCH=1 ;;
    --no-launch) LAUNCH=0 ;;
    --list)      xcrun devicectl list devices --timeout 15; exit 0 ;;
    -h|--help)   sed -n '2,16{s/^# \{0,1\}//;p;}' "$0"; exit 0 ;;
    *)           echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

# --- signing ---------------------------------------------------------------
[ -f "$HOME/.dash-ios-deploy.env" ] && source "$HOME/.dash-ios-deploy.env"
AUTH=()
if [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  AUTH=(-authenticationKeyPath "$ASC_KEY_PATH"
        -authenticationKeyID "$ASC_KEY_ID"
        -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

# --- device ----------------------------------------------------------------
# devicectl reports two ids per phone: the CoreDevice identifier (what devicectl
# takes) and the hardware udid (what xcodebuild -destination takes). We only
# ever need the former, because we build for a generic iOS destination.
resolve_device() {
  if [ -n "${DASH_IOS_DEVICE:-}" ] && [ -n "${DASH_IOS_UDID:-}" ]; then
    echo "$DASH_IOS_DEVICE $DASH_IOS_UDID"; return
  fi
  local json; json="$(mktemp -t dash-devices)"
  xcrun devicectl list devices --json-output "$json" --timeout 15 >/dev/null 2>&1 || true
  local found
  found="$(jq -r '[.result.devices[]
                   | select(.hardwareProperties.platform == "iOS")
                   | select(.connectionProperties.pairingState == "paired")]
                  | .[0] | select(. != null)
                  | "\(.identifier) \(.hardwareProperties.udid)"' "$json" 2>/dev/null || true)"
  rm -f "$json"
  [ -n "$found" ] || die "no paired iOS device found. Pair one in Xcode (Window > Devices and Simulators), then rerun. See --list."
  echo "$found"
}

# A wireless device drops off the network whenever the phone sleeps, so poll
# with a real query: it proves reachability *and* brings the tunnel up.
wait_for_device() {
  local dev="$1" deadline=$((SECONDS + WAIT_SECS)) announced=0
  while [ $SECONDS -lt $deadline ]; do
    if xcrun devicectl device info lockState --device "$dev" --timeout 10 >/dev/null 2>&1; then
      return 0
    fi
    if [ $announced -eq 0 ]; then
      log "waiting for the phone — unlock it and keep it on this Mac's Wi-Fi"
      announced=1
    fi
    sleep 3
  done
  die "phone did not come online within ${WAIT_SECS}s. Unlock it, confirm it's on the same Wi-Fi, and check Settings > Privacy & Security > Developer Mode."
}

# --- steps -----------------------------------------------------------------
build() {
  local udid="$1"
  log "building $SCHEME ($CONFIG) for device"
  # Target the phone by its hardware UDID — note that is a different identifier
  # from the CoreDevice one devicectl uses. It has to be a real device and not
  # `generic/platform=iOS`, because a generic destination gives Xcode no device
  # to register with the developer team, and a free Personal Team refuses to
  # issue a profile until at least one device is registered.
  xcodebuild -project Dash.xcodeproj -scheme "$SCHEME" -configuration "$CONFIG" \
    -destination "id=$udid" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates "${AUTH[@]+"${AUTH[@]}"}" -quiet build
}

app_path() {
  local p="$DERIVED/Build/Products/$CONFIG-iphoneos/Dash.app"
  [ -d "$p" ] || die "built app not found at $p"
  echo "$p"
}

deploy() {
  local dev="$1" udid="$2"
  # Wait first: the build now targets the real device, so it needs it present.
  wait_for_device "$dev"
  build "$udid"
  local app; app="$(app_path)"
  log "installing $(basename "$app")"
  xcrun devicectl device install app --device "$dev" "$app"
  if [ "$LAUNCH" -eq 1 ]; then
    log "launching $BUNDLE_ID"
    if ! xcrun devicectl device process launch --device "$dev" \
           --terminate-existing "$BUNDLE_ID" >/dev/null 2>&1; then
      warn "installed, but iOS refused to launch it."
      warn "If this is a new signing certificate, trust it on the phone:"
      warn "  Settings > General > VPN & Device Management > Developer App > Trust"
      warn "Otherwise check the phone is unlocked."
    fi
  fi
  log "done"
}

# mtime fingerprint of everything that can change the binary — no fswatch needed
fingerprint() {
  find Dash Config project.yml -type f -not -name '.DS_Store' \
    -exec stat -f '%m %N' {} + 2>/dev/null | sort | shasum | cut -d' ' -f1
}

read -r DEVICE UDID <<< "$(resolve_device)"
log "device $DEVICE (udid $UDID)"

if [ "$WATCH" -eq 0 ]; then
  deploy "$DEVICE" "$UDID"
  exit 0
fi

log "watch mode — Ctrl-C to stop"
deploy "$DEVICE" "$UDID" || warn "initial deploy failed; watching for changes anyway"
last="$(fingerprint)"
while true; do
  sleep 2
  now="$(fingerprint)"
  [ "$now" = "$last" ] && continue
  last="$now"
  log "change detected"
  deploy "$DEVICE" "$UDID" || warn "deploy failed — fix and save again"
done
