#!/usr/bin/env bash
# Checks that a node checkout is the pinned commit (NODE_COMMIT), not just whatever the release tag
# points at today: a tag can be moved, a commit can't. Run right after the clone, before anything is
# built from it.
#
# usage: NODE_COMMIT=<sha> check-source.sh <node source dir>
set -euo pipefail
: "${NODE_COMMIT:?NODE_COMMIT must be set}"
HEAD=$(git -C "$1" rev-parse HEAD)
if [ "$HEAD" != "$NODE_COMMIT" ]; then
  echo "::error::the node source is at $HEAD, not the pinned commit $NODE_COMMIT"
  exit 1
fi
echo "node source at the pinned commit $HEAD"
