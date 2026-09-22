#!/usr/bin/env bash
#
# Version-bump guard: fail when user-visible source changed without a bump.
#
# Why this lives in CI and not in kanban.version.test.js: that suite can only
# assert *internal consistency* (manifests agree, a CHANGELOG section exists for
# the CURRENT version, docs declare the same number). It cannot see the previous
# version, so a change can ship completely unbumped and still be green — which is
# exactly how the branch-field fix shipped while the live board still reported
# the old number. Answering "has this changed since the base branch?" needs git
# history, so the rule belongs here, at the gate that blocks the merge.
#
# Policy (README -> Releasing): every *user-visible* change bumps the version.
# Documentation-only and test-only changes legitimately do not, so they are
# excluded — a naive "any commit must bump" rule would fail most of this repo's
# history and would be disabled within a week.
#
# Usage: scripts/check-version-bump.sh <base-ref>
set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 <base-ref>" >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "$BASE" >/dev/null 2>&1; then
  echo "::error::base ref '$BASE' not found. Fetch it — actions/checkout needs fetch-depth: 0."
  exit 2
fi

VERSION_FILE="server/package.json"

# The top-level "version" key is the first one in the file, so taking the first
# match is exact. Kept dependency-free (no jq/node) so this can run anywhere.
extract_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

OLD="$(git show "$BASE:$VERSION_FILE" | extract_version)"
NEW="$(extract_version < "$VERSION_FILE")"

echo "base ($BASE): $OLD"
echo "head:         ${NEW:-(unreadable)}"

if [ -z "$OLD" ] || [ -z "$NEW" ]; then
  echo "::error::could not read a version from $VERSION_FILE (base='$OLD' head='$NEW')"
  exit 2
fi

# Three-dot diff = changes since the merge base, i.e. what this branch adds.
CHANGED="$(git diff --name-only "$BASE"...HEAD)"

# User-visible source: server runtime code (not tests), and the client tree.
SOURCE_RE='^(server/[^/]+\.js|server/(routes|middleware|utils)/.*\.js|client/src/.*)$'
# Excluded even inside those trees: tests and build output are not behaviour.
EXCLUDE_RE='(^server/test/|^client/src/.*\.test\.|\.test\.(js|mjs|ts|tsx)$)'

SOURCES="$(printf '%s\n' "$CHANGED" | grep -E "$SOURCE_RE" | grep -Ev "$EXCLUDE_RE" || true)"

if [ -z "$SOURCES" ]; then
  echo "No user-visible source changed (docs/tests/manifests only) — bump not required."
  exit 0
fi

echo "User-visible source changed:"
printf '  %s\n' $SOURCES

if [ "$OLD" = "$NEW" ]; then
  echo "::error::User-visible change without a version bump — $VERSION_FILE is still $NEW."
  echo "Bump it, mirror the number into package.json, and add a CHANGELOG section (README -> Releasing)."
  exit 1
fi

echo "Version bumped $OLD -> $NEW. OK."
