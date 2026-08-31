#!/usr/bin/env bash
set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XCODEGEN="$($IOS_DIR/scripts/bootstrap-xcodegen.sh)"

"$XCODEGEN" generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR"
