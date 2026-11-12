#!/usr/bin/env bash
# Applies native/patches/NNNN-*.patch, in order, to a clean checkout of the node source.
# Fails (and so fails the build) if any patch does not apply cleanly.
# Writes PATCHES.txt (patch names and sha256) into <node dir> and prints the patch-set id.
#
# usage: apply-patches.sh <node source dir>
set -euo pipefail
NODE=$(cd "$1" && pwd)
DIR=$(cd "$(dirname "$0")/patches" && pwd)
shopt -s nullglob
PATCHES=("$DIR"/[0-9][0-9][0-9][0-9]-*.patch)
[ ${#PATCHES[@]} -gt 0 ] || { echo "no patches in $DIR"; exit 1; }
: > "$NODE/PATCHES.txt"
for p in "${PATCHES[@]}"; do
  name=$(basename "$p")
  if ! git -C "$NODE" apply --check -p1 "$p"; then
    echo "::error::$name does not apply cleanly to $(git -C "$NODE" describe --tags --always)"
    exit 1
  fi
  git -C "$NODE" apply -p1 "$p"
  echo "$(sha256sum "$p" | cut -d' ' -f1)  $name" >> "$NODE/PATCHES.txt"
  echo "applied $name"
done
git -C "$NODE" status --short
# the id the patched node records in its replay marker (LOGOS_NODE_PATCHES_ID)
sha256sum "$NODE/PATCHES.txt" | cut -c1-16
