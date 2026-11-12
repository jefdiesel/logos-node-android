#!/usr/bin/env bash
# Compiles the small runner (runner/waku_runner.c) for Android arm64 against upstream's
# liblogosdelivery.so, and puts it next to the two libraries it needs.
#
# usage: build-runner.sh <lib dir> <out dir>
#   <lib dir> holds liblogosdelivery.so, librln.so, include/ (liblogosdelivery.h and
#   generated/) and tinycbor/ (the TinyCBOR copy nim-ffi generated the header against).
# env: ANDROID_NDK_HOME, ANDROID_API (default 30)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=$(cd "$1" && pwd); OUT=$2
API=${ANDROID_API:-30}
TC=${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64
CC=$TC/bin/aarch64-linux-android$API-clang
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)

# TinyCBOR: the typed helpers in the generated header encode and decode with it
for src in cborencoder.c cborencoder_close_container_checked.c cborparser.c cborparser_dup_string.c cborerrorstrings.c; do
  "$CC" -c -O2 -fPIC -std=gnu99 -I"$LIB/tinycbor" "$LIB/tinycbor/$src" -o "$WORK/${src%.c}.o"
done

# The header includes <tinycbor/cbor.h>, so the parent of tinycbor/ is on the include path.
# librln comes first: liblogosdelivery.so has no RUNPATH, so Android's linker can only satisfy
# its librln.so dependency with a copy the runner (RUNPATH=$ORIGIN) has already loaded.
# -Wl,--no-as-needed keeps librln.so in the runner's NEEDED list although the runner calls nothing in it.
"$CC" -O2 -fPIE -pie -std=gnu11 -Wall -Wno-unused-function \
  -I"$LIB/include" -I"$LIB" \
  "$HERE/runner/waku_runner.c" "$WORK"/*.o \
  -L"$LIB" -Wl,--no-as-needed -lrln -llogosdelivery -llog \
  -Wl,-rpath,'$ORIGIN' \
  -o "$OUT/waku-runner"

cp "$LIB/liblogosdelivery.so" "$LIB/librln.so" "$OUT/"
rm -rf "$WORK"
ls -la "$OUT"
