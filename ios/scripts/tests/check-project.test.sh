#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

REPO_DIR="$TMP_DIR/repo"
mkdir -p "$REPO_DIR/ios/scripts" \
  "$REPO_DIR/ios/Dash.xcodeproj/xcshareddata/xcschemes"
cp "$ROOT_DIR/ios/scripts/check-project.sh" "$REPO_DIR/ios/scripts/check-project.sh"

cat >"$REPO_DIR/ios/scripts/generate-project.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF
chmod +x "$REPO_DIR/ios/scripts/generate-project.sh"

printf '// generated project\n' >"$REPO_DIR/ios/Dash.xcodeproj/project.pbxproj"
printf '%s\n' \
  '<BuildableReference BuildableName = "DashContractTests.xctest" />' \
  >"$REPO_DIR/ios/Dash.xcodeproj/xcshareddata/xcschemes/Dash.xcscheme"

git -C "$REPO_DIR" init --quiet
git -C "$REPO_DIR" add ios
git -C "$REPO_DIR" -c user.name=Dash -c user.email=dash@example.invalid \
  commit --quiet -m baseline

printf 'untracked generated output\n' \
  >"$REPO_DIR/ios/Dash.xcodeproj/project.xcworkspace"

if OUTPUT="$("$REPO_DIR/ios/scripts/check-project.sh" 2>&1)"; then
  printf 'expected untracked generated output to fail drift detection\n' >&2
  exit 1
fi

if [[ "$OUTPUT" != *'Regenerate with ios/scripts/generate-project.sh and commit ios/Dash.xcodeproj'* ]]; then
  printf 'expected actionable project regeneration guidance, got:\n%s\n' "$OUTPUT" >&2
  exit 1
fi

printf 'PASS: project drift detection rejects untracked generated output\n'
