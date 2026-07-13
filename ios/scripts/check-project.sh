#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"$ROOT_DIR/ios/scripts/generate-project.sh"
cd "$ROOT_DIR"
if [[ ! -f ios/DashContractTests/FixtureLoader.swift ]] &&
  grep -Fq 'FixtureLoader.swift' ios/Dash.xcodeproj/project.pbxproj; then
  printf 'Generated project references missing DashContractTests/FixtureLoader.swift.\n' >&2
  exit 1
fi
EXPECTED_CONTRACT_SCHEME_REFERENCES=1
if [[ -f ios/DashContractTests/FixtureLoader.swift ]]; then
  EXPECTED_CONTRACT_SCHEME_REFERENCES=2
fi
CONTRACT_SCHEME_REFERENCES="$(
  grep -Fc 'BuildableName = "DashContractTests.xctest"' \
    ios/Dash.xcodeproj/xcshareddata/xcschemes/Dash.xcscheme || true
)"
if [[ "$CONTRACT_SCHEME_REFERENCES" -ne "$EXPECTED_CONTRACT_SCHEME_REFERENCES" ]]; then
  printf 'Expected %s DashContractTests scheme references, found %s.\n' \
    "$EXPECTED_CONTRACT_SCHEME_REFERENCES" "$CONTRACT_SCHEME_REFERENCES" >&2
  exit 1
fi
git diff --exit-code -- ios/Dash.xcodeproj
