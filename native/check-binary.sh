#!/usr/bin/env bash
# Checks that a built node binary is what its artifact name says: a patched binary must contain
# the patch name and the patch-set id it was built with; an unpatched one must contain neither.
#
# usage: check-binary.sh <binary> upstream
#        check-binary.sh <binary> patched|profile <patch-set id>
set -euo pipefail
BIN=$1; VARIANT=$2; ID=${3:-}
STRINGS=$(strings -a -n 8 "$BIN")
has() { grep -qF -- "$1" <<< "$STRINGS"; }
case "$VARIANT" in
  upstream)
    if has 0001-fast-replay-from-own-storage; then echo "::error::unpatched binary contains patch 0001"; exit 1; fi
    echo "ok: $BIN has no patches" ;;
  patched|profile)
    [ -n "$ID" ] || { echo "::error::no patch-set id given"; exit 1; }
    has 0001-fast-replay-from-own-storage || { echo "::error::patched binary lacks patch 0001"; exit 1; }
    has "$ID" || { echo "::error::patched binary lacks its patch-set id $ID"; exit 1; }
    echo "ok: $BIN contains patch 0001 and patch-set id $ID" ;;
  *) echo "unknown variant $VARIANT"; exit 1 ;;
esac
