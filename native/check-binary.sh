#!/usr/bin/env bash
# Checks that a built node binary is what its artifact name says: a patched binary must contain
# the patch names and the patch-set id it was built with; an unpatched one must contain none of them.
#
# usage: check-binary.sh <binary> upstream
#        check-binary.sh <binary> patched|profile|api <patch-set id>
#
# patched and profile carry every patch in native/patches; api carries patch 0002 alone.
set -euo pipefail
BIN=$1; VARIANT=$2; ID=${3:-}
STRINGS=$(strings -a -n 8 "$BIN")
has() { grep -qF -- "$1" <<< "$STRINGS"; }
case "$VARIANT" in
  upstream)
    for p in 0001-fast-replay-from-own-storage 0002-api-unix-socket; do
      if has "$p"; then echo "::error::unpatched binary contains patch $p"; exit 1; fi
    done
    echo "ok: $BIN has no patches" ;;
  patched|profile)
    [ -n "$ID" ] || { echo "::error::no patch-set id given"; exit 1; }
    has 0001-fast-replay-from-own-storage || { echo "::error::patched binary lacks patch 0001"; exit 1; }
    has 0002-api-unix-socket || { echo "::error::patched binary lacks patch 0002"; exit 1; }
    has "$ID" || { echo "::error::patched binary lacks its patch-set id $ID"; exit 1; }
    echo "ok: $BIN contains patches 0001 and 0002 and patch-set id $ID" ;;
  api)
    [ -n "$ID" ] || { echo "::error::no patch-set id given"; exit 1; }
    has 0002-api-unix-socket || { echo "::error::api binary lacks patch 0002"; exit 1; }
    if has 0001-fast-replay-from-own-storage; then echo "::error::api binary contains patch 0001"; exit 1; fi
    has "$ID" || { echo "::error::api binary lacks its patch-set id $ID"; exit 1; }
    echo "ok: $BIN contains patch 0002 alone and patch-set id $ID" ;;
  *) echo "unknown variant $VARIANT"; exit 1 ;;
esac
