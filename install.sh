#!/usr/bin/env bash
#
# Dash one-line installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/volumegambit/Dash/main/install.sh | sh
#
# Detects arch, downloads the latest signed-free DMG from GitHub releases,
# copies Dash.app to /Applications, and strips the macOS quarantine xattr
# (works around "app is damaged" since builds are not yet code-signed).

set -euo pipefail

REPO="volumegambit/Dash"
APP_NAME="Dash"
APP_PATH="/Applications/${APP_NAME}.app"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
info()   { printf '  %s\n' "$*"; }

die() { red "✗ $*"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is macOS-only."

case "$(uname -m)" in
  arm64)  ASSET_SUFFIX="arm64.dmg" ;;
  x86_64) ASSET_SUFFIX="dmg" ;;
  *)      die "Unsupported architecture: $(uname -m)" ;;
esac

green "→ Fetching latest Dash release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest") \
  || die "Could not reach GitHub API."

TAG=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$TAG" ] || die "Could not determine latest release tag."

# Pick the right asset: -arm64.dmg for Apple Silicon, plain .dmg for Intel.
# The Intel build has no arch suffix in its filename, so we use a negative
# match when ASSET_SUFFIX is just "dmg".
if [ "$ASSET_SUFFIX" = "dmg" ]; then
  DMG_URL=$(printf '%s' "$RELEASE_JSON" \
    | grep -oE 'https://[^"]+\.dmg' \
    | grep -v 'arm64' \
    | grep -v 'blockmap' \
    | head -1)
else
  DMG_URL=$(printf '%s' "$RELEASE_JSON" \
    | grep -oE "https://[^\"]+${ASSET_SUFFIX}" \
    | grep -v 'blockmap' \
    | head -1)
fi
[ -n "$DMG_URL" ] || die "No matching DMG asset found in release ${TAG}."

info "version  : ${TAG}"
info "arch     : $(uname -m)"
info "download : ${DMG_URL##*/}"

if [ -d "$APP_PATH" ]; then
  yellow "⚠ ${APP_NAME}.app already exists in /Applications."
  if pgrep -f "${APP_PATH}/Contents/MacOS" >/dev/null; then
    info "${APP_NAME} is running. Quitting it..."
    osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
    sleep 2
  fi
  info "Replacing existing install..."
  rm -rf "$APP_PATH"
fi

TMP=$(mktemp -d -t dash-install)
trap 'cd /; [ -n "${MOUNT:-}" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rm -rf "$TMP"' EXIT

DMG_FILE="${TMP}/Dash.dmg"
green "→ Downloading..."
curl -fSL --progress-bar "$DMG_URL" -o "$DMG_FILE" \
  || die "Download failed."

green "→ Mounting..."
# -plist gives parseable output without needing -quiet vs verbose tradeoff.
ATTACH_OUT=$(hdiutil attach -nobrowse -readonly -plist "$DMG_FILE" 2>/dev/null)
MOUNT=$(printf '%s' "$ATTACH_OUT" \
  | awk '/<key>mount-point<\/key>/{getline; print}' \
  | sed -E 's/.*<string>([^<]+)<\/string>.*/\1/' \
  | head -1)
[ -d "$MOUNT" ] || die "Could not locate mount point."

green "→ Copying to /Applications..."
cp -R "${MOUNT}/${APP_NAME}.app" /Applications/ \
  || die "Copy failed. Try running with sudo if /Applications is not writable."

green "→ Removing quarantine attributes..."
xattr -cr "$APP_PATH"

green "✓ Installed ${APP_NAME} ${TAG}"
info "Launch with: open -a ${APP_NAME}"
