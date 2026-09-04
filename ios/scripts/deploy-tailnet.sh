#!/bin/bash
# Build Dash iOS and publish it to your tailnet for over-the-air install.
#
# Unlike deploy-device.sh this does NOT need the phone on the local network:
# Apple's wireless install uses Bonjour/mDNS, which Tailscale (a layer-3 overlay
# with no multicast) cannot carry. Instead we export a development-signed .ipa,
# serve it over Tailscale HTTPS, and let iOS install it from that URL. Works
# anywhere the phone has the tailnet, cellular included.
#
#   ios/scripts/deploy-tailnet.sh            build, publish, print the install URL
#   ios/scripts/deploy-tailnet.sh --stop     take the serve down
#   ios/scripts/deploy-tailnet.sh --no-serve build + stage only
#
# Env:
#   DASH_IOS_CONFIG  Debug (default) or Release
#   DASH_IOS_PATH    tailnet URL path (default /dash)
#
# Signing: needs an Apple ID in Xcode > Settings > Accounts, or an App Store
# Connect key in ~/.dash-ios-deploy.env. The phone's UDID must be registered
# with the team, otherwise iOS refuses the install.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID="app.dash.ios"
SCHEME="Dash"
CONFIG="${DASH_IOS_CONFIG:-Debug}"
URL_PATH="${DASH_IOS_PATH:-/dash}"
STAGE="build/tailnet"
ARCHIVE="build/Dash-dev.xcarchive"
PORT="${DASH_IOS_PORT:-8787}"
PIDFILE="build/tailnet-httpd.pid"
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
[ -x "$TS" ] || TS="$(command -v tailscale || true)"

SERVE=1
for arg in "$@"; do
  case "$arg" in
    --no-serve) SERVE=0 ;;
    --stop)     "$TS" serve --https=443 --set-path "$URL_PATH" off >/dev/null 2>&1 \
                  || "$TS" serve reset >/dev/null 2>&1 || true
                [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
                rm -f "$PIDFILE"; echo "serve stopped"; exit 0 ;;
    -h|--help)  sed -n '2,20{s/^# \{0,1\}//;p;}' "$0"; exit 0 ;;
    *)          echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$TS" ] && [ -x "$TS" ] || die "tailscale CLI not found"

[ -f "$HOME/.dash-ios-deploy.env" ] && source "$HOME/.dash-ios-deploy.env"
AUTH=()
if [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  AUTH=(-authenticationKeyPath "$ASC_KEY_PATH"
        -authenticationKeyID "$ASC_KEY_ID"
        -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

HOSTNAME_TS="$("$TS" status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
[ -n "$HOSTNAME_TS" ] && [ "$HOSTNAME_TS" != "null" ] || die "could not read this machine's tailnet name"
"$TS" status --json | jq -e --arg h "$HOSTNAME_TS" '.CertDomains | index($h)' >/dev/null \
  || die "HTTPS certs are not enabled for $HOSTNAME_TS. Enable HTTPS in the Tailscale admin console — iOS refuses OTA installs without a valid certificate."

BASE="https://${HOSTNAME_TS}${URL_PATH}"
# A fresh build number makes iOS treat every deploy as an upgrade.
BUILD_NUM="$(git rev-list --count HEAD 2>/dev/null || date +%s)"

log "archiving $SCHEME ($CONFIG, build $BUILD_NUM)"
rm -rf "$ARCHIVE"
xcodebuild -project Dash.xcodeproj -scheme "$SCHEME" -configuration "$CONFIG" \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  CURRENT_PROJECT_VERSION="$BUILD_NUM" \
  -allowProvisioningUpdates "${AUTH[@]+"${AUTH[@]}"}" -quiet archive

log "exporting development-signed .ipa"
rm -rf "$STAGE"; mkdir -p "$STAGE"

# Two "Apple Development" certificates with identical names can sit in the
# keychain at once (Xcode issues a new one on some sign-ins). exportArchive may
# then pick one the provisioning profile does not contain and fail with
# "doesn't include signing certificate". Pin whichever certificate the archive
# was actually signed with.
EXPORT_OPTS="Config/ExportOptions-Development.plist"
CERT_SHA="$(security cms -D -i "$ARCHIVE/Products/Applications/Dash.app/embedded.mobileprovision" 2>/dev/null \
  | plutil -extract DeveloperCertificates.0 raw - 2>/dev/null \
  | base64 -d 2>/dev/null \
  | openssl x509 -inform DER -noout -fingerprint -sha1 2>/dev/null \
  | sed 's/.*=//; s/://g')"
if [ -n "$CERT_SHA" ]; then
  EXPORT_OPTS="$(mktemp -t dash-export-opts)"
  cp Config/ExportOptions-Development.plist "$EXPORT_OPTS"
  plutil -replace signingCertificate -string "$CERT_SHA" "$EXPORT_OPTS"
  log "pinning signing certificate $CERT_SHA"
fi

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_OPTS" \
  -exportPath "$STAGE" -allowProvisioningUpdates "${AUTH[@]+"${AUTH[@]}"}" -quiet

IPA="$(find "$STAGE" -maxdepth 1 -name '*.ipa' | head -1)"
[ -n "$IPA" ] || die "no .ipa produced — check the export log above"
mv "$IPA" "$STAGE/Dash.ipa"
# Publish only what the install needs — the export also drops Packaging.log, a
# DistributionSummary and a copy of ExportOptions that would otherwise be
# served on the tailnet alongside the app.
find "$STAGE" -maxdepth 1 -type f ! -name 'Dash.ipa' -delete

VERSION="$(grep -E '^MARKETING_VERSION' Config/Base.xcconfig | sed 's/.*= *//')"

log "writing OTA manifest"
cat > "$STAGE/manifest.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
				<dict>
					<key>kind</key><string>software-package</string>
					<key>url</key><string>${BASE}/Dash.ipa</string>
				</dict>
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key><string>${BUNDLE_ID}</string>
				<key>bundle-version</key><string>${VERSION}</string>
				<key>kind</key><string>software</string>
				<key>title</key><string>Dash</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
PLIST
plutil -lint "$STAGE/manifest.plist" >/dev/null || die "generated manifest is malformed"

# iOS only follows itms-services:// from a tapped link, so serve a tiny page.
cat > "$STAGE/index.html" <<HTML
<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Dash</title>
<style>body{font:-apple-system-body,system-ui;display:grid;place-items:center;
min-height:90vh;margin:0;text-align:center}a{background:#111;color:#fff;
padding:1rem 2rem;border-radius:12px;text-decoration:none;font-weight:600}
small{color:#666;display:block;margin-top:1.5rem}</style>
<div><h1>Dash</h1>
<a href="itms-services://?action=download-manifest&amp;url=${BASE}/manifest.plist">Install</a>
<small>${VERSION} (build ${BUILD_NUM})</small></div>
HTML

if [ "$SERVE" -eq 1 ]; then
  log "publishing to the tailnet"
  # The macOS Tailscale app is sandboxed and refuses to serve a directory
  # ("Path serving is not supported on macOS"), so run a local static server
  # and have Tailscale proxy that port instead.
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$STAGE" \
    >/dev/null 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/manifest.plist" \
    || die "local server did not come up on port $PORT"
  "$TS" serve --bg --set-path "$URL_PATH" "$PORT" >/dev/null
fi

log "done — open this on the iPhone and tap Install:"
printf '\n    %s/\n\n' "$BASE"
log "the phone needs Tailscale connected; run --stop when you are finished"
