#!/bin/bash
# Patches the dev Electron binary's Info.plist so the macOS dock shows
# "Dash (dev)" instead of "Electron". Safe to re-run — idempotent.

PLIST="$(dirname "$0")/../../../node_modules/electron/dist/Electron.app/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "Electron plist not found at $PLIST — skipping dock name patch"
  exit 0
fi

CURRENT_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$PLIST" 2>/dev/null)
if [ "$CURRENT_NAME" = "Dash (dev)" ]; then
  exit 0
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleName 'Dash (dev)'" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'Dash (dev)'" "$PLIST"
echo "Patched Electron dock name → Dash (dev)"
