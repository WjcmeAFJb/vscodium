#!/usr/bin/env bash
# Cut a tagged release of the Dance-embedded VSCodium fork.
#
# The CI workflow only publishes to GitHub Releases on `v*` tag pushes, so
# this is the canonical entry point for producing a downloadable build.
#
# Usage: ./dev/cut-release.sh                # auto-derives version from upstream
#        ./dev/cut-release.sh 1.116.05012    # explicit RELEASE_VERSION

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -n "${1:-}" ]]; then
  VERSION="$1"
else
  MS_TAG=$(jq -r '.tag' upstream/stable.json)
  TIME_PATCH=$(printf "%04d" $(( $(date +%-j) * 24 + $(date +%-H) )))
  VERSION="${MS_TAG}${TIME_PATCH}"
fi

TAG="v${VERSION}"

if git tag --list "$TAG" | grep -q .; then
  echo "tag $TAG already exists locally — bump the version" >&2
  exit 1
fi

echo "tagging $TAG …"
git tag -a "$TAG" -m "VSCodium with Dance — $VERSION"
git push origin "$TAG"

echo
echo "Tag pushed. Watch the build at:"
echo "  https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions"
