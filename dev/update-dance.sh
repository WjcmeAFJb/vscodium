#!/usr/bin/env bash
# Refresh the embedded Dance bundle from the upstream repository.
#
# Usage: ./dev/update-dance.sh [git-ref]
#   git-ref defaults to master; pass a tag/sha to pin a specific revision.

set -euo pipefail

REF="${1:-master}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/stable/extensions/dance"

echo "Cloning 71/dance @ $REF into $WORKDIR …"
git clone --depth 1 --branch "$REF" https://github.com/71/dance.git "$WORKDIR/dance" 2>/dev/null \
  || { git clone --depth 1 https://github.com/71/dance.git "$WORKDIR/dance"; (cd "$WORKDIR/dance" && git fetch --depth 1 origin "$REF" && git checkout FETCH_HEAD); }

cd "$WORKDIR/dance"
yarn install
yarn run compile
yarn run compile-web

echo "Copying bundle to $DEST_DIR/out/"
cp out/extension.js out/web-extension.js "$DEST_DIR/out/"

echo "Updating manifest …"
python3 - <<PYEOF
import json, os
src = "$WORKDIR/dance/package.json"
dst = "$DEST_DIR/package.json"
with open(src) as f:
    pkg = json.load(f)
for k in ('scripts', 'devDependencies', 'dependencies'):
    pkg.pop(k, None)
pkg['__metadata'] = {
    'id': 'dance-builtin',
    'publisherId': 'gregoire-builtin',
    'publisherDisplayName': 'gregoire',
    'isPreReleaseVersion': False,
    'targetPlatform': 'undefined',
    'isBuiltin': True,
}
pkg['extensionKind'] = ['ui', 'workspace']
pkg.setdefault('engines', {})['vscode'] = '^1.0.0'
with open(dst, 'w') as f:
    json.dump(pkg, f, indent=2)
print(f"Wrote {dst} ({os.path.getsize(dst)} bytes)")
PYEOF

cp LICENSE "$DEST_DIR/LICENSE"
cp README.md "$DEST_DIR/README.md"

echo "Done. Don't forget to git add & commit the updated bundle."
