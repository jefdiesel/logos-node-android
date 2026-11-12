#!/usr/bin/env bash
# Applies native/patches/NNNN-*.patch in order, then any extra patch files given, to a clean
# checkout of the node source. Stops with an error if any patch does not apply cleanly.
# Writes <node dir>/PATCHES.txt (sha256 and name of every patch applied) and <node dir>/PATCHES.id
# (the patch-set id: a digest of PATCHES.txt). The patched node records that id in its replay
# marker (build env LOGOS_NODE_PATCHES_ID), so different patch sets never share a marker.
#
# usage: apply-patches.sh <node source dir> [extra patch file...]
set -euo pipefail
NODE=$(cd "$1" && pwd); shift
DIR=$(cd "$(dirname "$0")/patches" && pwd)
shopt -s nullglob
PATCHES=("$DIR"/[0-9][0-9][0-9][0-9]-*.patch)
for extra in "$@"; do PATCHES+=("$(cd "$(dirname "$extra")" && pwd)/$(basename "$extra")"); done
[ ${#PATCHES[@]} -gt 0 ] || { echo "no patches in $DIR"; exit 1; }
[ ! -e "$NODE/PATCHES.txt" ] || { echo "$NODE already has patches applied"; exit 1; }
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
sha256sum "$NODE/PATCHES.txt" | cut -c1-16 > "$NODE/PATCHES.id"
echo "patch set id: $(cat "$NODE/PATCHES.id")"
