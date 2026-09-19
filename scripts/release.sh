#!/usr/bin/env bash
# Cut a Dash release from a clean, up-to-date main.
#
#   scripts/release.sh patch|minor|major [--dry-run]
#
# Bumps the root package.json, runs `npm run version:sync` so every workspace,
# bundled plugin, and the iOS MARKETING_VERSION agree, commits, tags vX.Y.Z,
# and pushes branch + tag. The tag push is what starts .github/workflows/release.yml.
# --dry-run prints the next version and exits before changing anything.
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="${1:-}"
DRY_RUN=0
case "${2:-}" in --dry-run) DRY_RUN=1 ;; '') ;; *) echo "unknown flag: $2" >&2; exit 2 ;; esac
case "$BUMP" in patch|minor|major) ;; *) echo "usage: scripts/release.sh patch|minor|major [--dry-run]" >&2; exit 2 ;; esac

die() { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

command -v node >/dev/null || die "node not on PATH"
[ "$(git branch --show-current)" = "main" ] || die "release from main (currently on $(git branch --show-current))"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not at origin/main — pull or push first"

CURRENT="$(node -p "require('./package.json').version")"
IFS=. read -r MAJOR MINOR PATCH <<<"$CURRENT"
case "$BUMP" in
  patch) NEXT="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEXT="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEXT="$((MAJOR + 1)).0.0" ;;
esac
TAG="v$NEXT"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"

log "release $CURRENT -> $NEXT ($BUMP)"
if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: would bump to $NEXT, run version:sync, commit, tag $TAG, and push"
  exit 0
fi

npm version "$NEXT" --no-git-tag-version >/dev/null
npm run version:sync --silent
node scripts/check-release-version.mjs "$TAG"

# Stage only the files version:sync touches — never `git add -A`.
git add package.json package-lock.json ios/Config/Base.xcconfig
git add contracts/mobile/v1/package.json packages/*/package.json apps/*/package.json
git add packages/skills/plugins/*/.claude-plugin/plugin.json 2>/dev/null || true
git commit -q -m "chore(release): $TAG"
git tag -a "$TAG" -m "Dash $TAG"

log "pushing main and $TAG"
git push origin main "$TAG"
log "done — follow the run at https://github.com/volumegambit/Dash/actions/workflows/release.yml"
