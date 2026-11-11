#!/usr/bin/env bash
# Builds the Logos node's ZK witness-generator libraries for Android (arm64) and assembles a
# circuits folder (LBC_ROOT_DIR) that the node's own build accepts.
#
# Upstream publishes these libraries for Linux, macOS and Windows only. This follows the same
# steps as upstream's CI (logos-blockchain-circuits/.github), with the Android NDK compiler.
# The proving and verification keys are taken unchanged from the official release: they are
# tied to the release and must not be regenerated.
#
# usage: build-circuits.sh <node source dir> <output dir>
set -euo pipefail
NODE_DIR=$(cd "$1" && pwd); OUT=$2
WORK=${WORK:-$PWD/work}; API=${ANDROID_API:-28}
NDK=${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}}
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64
CXX=$TC/bin/aarch64-linux-android$API-clang++
CC=$TC/bin/aarch64-linux-android$API-clang
mkdir -p "$WORK" "$OUT"; OUT=$(cd "$OUT" && pwd); cd "$WORK"

# versions come from the node's own Cargo.toml, so a node bump carries them along
LBC_TAG=$(grep -m1 -E '^lbc-pol-sys' "$NODE_DIR/Cargo.toml" | sed -E 's/.*tag = "([^"]+)".*/\1/')
RS_REV=$(grep -m1 -E '^rust-rapidsnark' "$NODE_DIR/Cargo.toml" | sed -E 's/.*rev = "([^"]+)".*/\1/')
RS_VER=$(curl -fsSL "https://raw.githubusercontent.com/logos-blockchain/logos-blockchain-rust-rapidsnark/$RS_REV/RAPIDSNARK_VERSION" | tr -d '[:space:]')
echo "circuits $LBC_TAG, rapidsnark $RS_VER, android api $API, ndk $(basename "$NDK")"

# 1. circuits source at the node's tag
[ -d circuits ] || git clone -q --depth 1 --branch "$LBC_TAG" https://github.com/logos-blockchain/logos-blockchain-circuits.git circuits
(cd circuits && git submodule update -q --init --depth 1 circomlib)
CIRCOM_TAG=$(grep -m1 'CIRCOM_TAG:' circuits/.github/workflows/ci.yml | awk '{print $2}')
if ! circom --version 2>/dev/null | grep -q "${CIRCOM_TAG#v}"; then
  echo "installing circom $CIRCOM_TAG..."
  rm -rf circom-src && git clone -q --depth 1 --branch "$CIRCOM_TAG" https://github.com/iden3/circom.git circom-src
  (cd circom-src && RUSTFLAGS="-A dead_code" cargo install -q --path circom)
fi
circom --version

# 2. official release: keys and data files (same on every platform)
REL=logos-blockchain-circuits-$LBC_TAG-linux-aarch64
[ -d "$REL" ] || curl -fsSL "https://github.com/logos-blockchain/logos-blockchain-circuits/releases/download/$LBC_TAG/$REL.tar.gz" | tar xz
cp -r "$REL"/. "$OUT"/
find "$OUT" -name '*.a' -delete

# 3. GMP for Android: the same archive the node's prover library links (iden3 rapidsnark), so
#    there is exactly one GMP in the final binary. Its header comes from a GMP configure run.
RS=rapidsnark-android-arm64-v$RS_VER
[ -d rs ] || { curl -fsSL -o rs.zip "https://github.com/iden3/rapidsnark/releases/download/v$RS_VER/$RS.zip"; mkdir rs; unzip -q rs.zip -d rs; }
find rs -type f | sed 's/^/  rapidsnark zip: /'
GMP_A=$(find rs -name libgmp.a | head -1); [ -n "$GMP_A" ] || { echo "no libgmp.a in the rapidsnark archive"; exit 1; }
INC=$WORK/inc; mkdir -p "$INC"
GMP_H=$(find rs -name gmp.h | head -1)
if [ -n "$GMP_H" ]; then cp "$GMP_H" "$INC/gmp.h"; else
  [ -d gmp-6.2.1 ] || { for u in https://ftp.gnu.org/gnu/gmp https://gmplib.org/download/gmp https://ftpmirror.gnu.org/gmp; do curl -fsSL --retry 3 -o gmp.tar.xz "$u/gmp-6.2.1.tar.xz" && break; done; tar xf gmp.tar.xz; }
  (cd gmp-6.2.1 && ./configure --host=aarch64-linux-android --disable-shared --with-pic --disable-fft CC="$CC" CFLAGS="-O2" >/dev/null && cp gmp.h "$INC/gmp.h")
fi
cp -r /usr/include/nlohmann "$INC/"        # header-only JSON library used by circom's main.cpp
mkdir -p "$OUT/lib" && cp "$GMP_A" "$OUT/lib/libgmp.a"
# The circuits crates ask the linker for "stdc++" and the prover crate for "c++". Android's C++
# library is libc++, and a standalone executable is simplest with it linked statically (nothing to
# ship next to the binary). This folder is a linker search path, so these two linker scripts, the
# same one older NDKs shipped as libc++.a (r30 no longer does), turn both requests into the static
# libc++. The resulting binary needs only libc, libm and libdl from the system.
for l in libstdc++.a libc++.a; do echo 'INPUT(-lc++_static -lc++abi)' > "$OUT/lib/$l"; done

# 4. the four witness generators
for entry in "pol mantle" "poq blend" "signature mantle" "poc mantle"; do
  set -- $entry; C=$1; DIR=circuits/$2; CPP=$DIR/${C}_cpp
  echo "== $C"
  (cd "$DIR" && circom --c --r1cs --no_asm --O2 "$C.circom" >/dev/null)
  cp -r "circuits/src/$C" "$CPP/$C"
  cp circuits/src/circom_adapter.cpp circuits/src/circom_adapter.hpp circuits/src/circom_fwd.hpp circuits/src/types.hpp circuits/src/assert.h "$CPP/"
  sed -i ':a;N;$!ba;s/\n}\n\n*$/\n  return 0;\n}/' "$CPP/main.cpp"      # same two patches as upstream CI
  sh circuits/.github/resources/witness-generator/fix_calcwit_leak.sh "$CPP"
  (cd "$CPP"
   for src in main.cpp calcwit.cpp fr.cpp "$C.cpp" "$C/ffi.cpp" circom_adapter.cpp; do
     "$CXX" -std=c++11 -O3 -I. -I"$INC" -Wno-address-of-packed-member -Dmain=circom_main -fPIC -c "$src" -o "$(basename "${src%.cpp}").o"
   done
   # keep only the two entry points visible, so the four libraries can live in one binary
   "$TC/bin/ld.lld" -r -o local.o main.o calcwit.o fr.o "$C.o" ffi.o circom_adapter.o
   "$TC/bin/llvm-objcopy" --keep-global-symbol="${C}_generate_witness" --keep-global-symbol="${C}_generate_witness_from_files" local.o
   "$TC/bin/llvm-ar" rcs "lib$C.a" local.o)
  "$TC/bin/llvm-nm" -g --defined-only "$CPP/lib$C.a" | grep -c generate_witness
  if cmp -s "$CPP/$C.dat" "$OUT/$C/witness_generator.dat"; then echo "$C.dat matches the official release"; else echo "WARNING: $C.dat differs from the official release"; fi
  cp "$CPP/lib$C.a" "$OUT/$C/lib$C.a"; cp "$CPP/$C.dat" "$OUT/$C/witness_generator.dat"
done
echo "done:"; find "$OUT" -maxdepth 2 \( -name '*.a' -o -name '*.zkey' \) -exec ls -la {} \;
