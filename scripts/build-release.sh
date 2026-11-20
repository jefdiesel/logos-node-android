#!/bin/bash
# scripts/build-release.sh [out-dir]
#
# The release APK of the Android app: not debuggable (no `run-as`, no WebView remote debugging, none of the debug
# builds' adb extras) and signed with YOUR release key, built on your own computer. CI never builds it: the repository
# is public and CI must never hold the key. See android/NAMES04.md, "The release build".
#
# What it does:
#   1. checks the release key (four environment variables, below) and the tools, before anything slow;
#   2. takes this checkout's HEAD commit, exactly as committed (`git archive`: nothing uncommitted, nothing ignored),
#      into a fresh folder under $TMPDIR, so the build never touches this checkout;
#   3. puts in the binaries pinned in android/*.properties and android/messaging-*, from the same CI runs as the debug
#      APK, each checked against its pinned sha256 (as .github/workflows/android-app.yml does);
#   4. runs the release unit tests and `assembleRelease`;
#   5. checks the APK: signed with your key (not the public debug key), not debuggable, every pinned binary and web app
#      file byte for byte; then copies it, with SHA256SUMS, to out-dir (default $TMPDIR/logos-release-out).
#
# The key (never inside this repository, never passed with -P on a command line):
#   LOGOS_RELEASE_STORE_FILE      the keystore file (.jks or .p12), outside the repository
#   LOGOS_RELEASE_STORE_PASSWORD  its password
#   LOGOS_RELEASE_KEY_ALIAS       the key's alias in it
#   LOGOS_RELEASE_KEY_PASSWORD    the key's password (the same as the store's for a .p12)
# Keep the keystore and its passwords for as long as the app is used: every later release must be signed with the
# same key, or the phone has to uninstall the app (and lose its data) to take it.
#
# Tools: JDK 17 (JAVA_HOME or java on PATH), the Android SDK at ANDROID_HOME with platform 36 and build-tools 36.0.0
# (installed with its sdkmanager if missing), gh signed in to GitHub (to download the pinned CI artifacts), unzip.
# Gradle 8.14.3 is downloaded once into the Gradle home if `gradle` isn't on PATH. GRADLE_USER_HOME defaults to
# $TMPDIR/logos-release-gradle-home.
#
# On the MacBook, only through laptop-build.sh (its TMPDIR is on the external SSD, so the build and Gradle's caches
# land there, never on the internal disk):
#   export ANDROID_HOME=/Volumes/Bitcoin/logos-build/android-sdk
#   export LOGOS_RELEASE_STORE_FILE=... LOGOS_RELEASE_STORE_PASSWORD=... LOGOS_RELEASE_KEY_ALIAS=... LOGOS_RELEASE_KEY_PASSWORD=...
#   ~/logos/laptop-build.sh scripts/build-release.sh
set -euo pipefail

say() { printf '%s\n' "$*"; }
fail() { printf 'build-release: %s\n' "$*" >&2; exit 1; }

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || fail "run it from a checkout of logos-node-android"
OUT=${1:-${TMPDIR:-/tmp}/logos-release-out}
GRADLE_VERSION=8.14.3
BUILD_TOOLS=36.0.0
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
sha256_stdin() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# ---- 1. the key ----------------------------------------------------------------------------------------------------
missing=""
for v in LOGOS_RELEASE_STORE_FILE LOGOS_RELEASE_STORE_PASSWORD LOGOS_RELEASE_KEY_ALIAS LOGOS_RELEASE_KEY_PASSWORD; do
  [ -n "${!v:-}" ] || missing="$missing $v"
done
[ -z "$missing" ] || fail "no release key: set$missing (see the top of this script). Nothing was built."
STORE=$(cd "$(dirname "$LOGOS_RELEASE_STORE_FILE")" 2>/dev/null && pwd -P)/$(basename "$LOGOS_RELEASE_STORE_FILE") \
  || fail "LOGOS_RELEASE_STORE_FILE: its folder doesn't exist"
[ -f "$STORE" ] || fail "LOGOS_RELEASE_STORE_FILE is not a file: $STORE"
REPO_REAL=$(cd "$REPO" && pwd -P)
case "$STORE" in "$REPO_REAL"/*) fail "the keystore is inside the repository ($STORE). Keep it outside, so it can never be committed." ;; esac
[ "$(basename "$STORE")" != debug.keystore ] || fail "that is the public debug key; a release is signed with your own key"
export LOGOS_RELEASE_STORE_FILE="$STORE"

# ---- tools ---------------------------------------------------------------------------------------------------------
JAVA=${JAVA_HOME:+$JAVA_HOME/bin/}java
KEYTOOL=${JAVA_HOME:+$JAVA_HOME/bin/}keytool
JV=$("$JAVA" -version 2>&1 || true)
case "$JV" in *'version "17'*) ;; *) fail "JDK 17 is needed (JAVA_HOME, or java on PATH): $(printf '%s\n' "$JV" | awk 'NR==1')" ;; esac

# the key opens, with the alias asked for (passwords from the environment, never on a command line)
"$KEYTOOL" -list -keystore "$STORE" -storepass:env LOGOS_RELEASE_STORE_PASSWORD -alias "$LOGOS_RELEASE_KEY_ALIAS" >/dev/null 2>&1 \
  || fail "the keystore doesn't open with LOGOS_RELEASE_STORE_PASSWORD, or has no key '$LOGOS_RELEASE_KEY_ALIAS'"
cert_of() {   # the SHA-256 of a keystore entry's certificate, lowercase hex without colons
  local out
  out=$("$KEYTOOL" -list -v -keystore "$1" "${@:3}" -alias "$2" 2>/dev/null) || return 0
  printf '%s\n' "$out" | sed -n 's/^[[:space:]]*SHA256: //p' | awk 'NR==1' | tr -d ':' | tr 'A-F' 'a-f'
}
RELEASE_CERT=$(cert_of "$STORE" "$LOGOS_RELEASE_KEY_ALIAS" -storepass:env LOGOS_RELEASE_STORE_PASSWORD)
DEBUG_CERT=$(cert_of "$REPO/android/debug.keystore" androiddebugkey -storepass android)
[ -n "$RELEASE_CERT" ] || fail "couldn't read the release key's certificate"
[ "$RELEASE_CERT" != "$DEBUG_CERT" ] || fail "that keystore holds the public debug key; a release is signed with your own key"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || fail "gh must be installed and signed in (it downloads the pinned CI artifacts)"
command -v unzip >/dev/null || fail "unzip is needed"
[ -n "${ANDROID_HOME:-}" ] || fail "set ANDROID_HOME to the Android SDK (on the MacBook: /Volumes/Bitcoin/logos-build/android-sdk)"
case "$ANDROID_HOME" in "$HOME"/*|/Users/*) [ "$(uname)" = Darwin ] && fail "ANDROID_HOME is on the internal disk; put the SDK on /Volumes/Bitcoin" ;; esac
if [ ! -d "$ANDROID_HOME/platforms/android-36" ] || [ ! -x "$ANDROID_HOME/build-tools/$BUILD_TOOLS/apksigner" ]; then
  SDKM=$(command -v sdkmanager || echo "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager")
  [ -x "$SDKM" ] || fail "ANDROID_HOME lacks platform 36 or build-tools $BUILD_TOOLS, and no sdkmanager to install them"
  say "== installing platform 36 and build-tools $BUILD_TOOLS into $ANDROID_HOME"
  set +o pipefail                                   # (`yes` ends on SIGPIPE when sdkmanager is done)
  yes | "$SDKM" --sdk_root="$ANDROID_HOME" --install "platforms;android-36" "build-tools;$BUILD_TOOLS" >/dev/null || true
  set -o pipefail
  [ -d "$ANDROID_HOME/platforms/android-36" ] && [ -x "$ANDROID_HOME/build-tools/$BUILD_TOOLS/apksigner" ] \
    || fail "sdkmanager didn't install platform 36 and build-tools $BUILD_TOOLS into $ANDROID_HOME"
fi
BT="$ANDROID_HOME/build-tools/$BUILD_TOOLS"

# ---- 2. the commit, in a folder of its own -------------------------------------------------------------------------
COMMIT=$(git -C "$REPO" rev-parse HEAD)
[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] \
  || say "note: this checkout has uncommitted changes; they are NOT in the release (it is built from $COMMIT as committed)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/logos-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/src"
git -C "$REPO" archive "$COMMIT" | tar -x -C "$WORK/src"
cd "$WORK/src"
say "== building commit $COMMIT in $WORK/src"

# ---- 3. the pinned binaries (as android-app.yml) -------------------------------------------------------------------
REPO_GH=jefdiesel/logos-node-android
J=android/app/src/main/jniLibs/arm64-v8a
mkdir -p "$J"
prop() { sed -n "s/^$2=//p" "$1" | tr -d '[:space:]'; }
VARIANT=$(prop android/node.properties variant); VERSION=$(prop android/node.properties version)
NODE_RUN=$(prop android/node.properties run); NODE_SHA=$(prop android/node.properties "$VARIANT.sha256")
case "$VARIANT" in patched) NAME="logos-blockchain-node-android-arm64-$VERSION-patched" ;;
                   api) NAME="logos-blockchain-node-android-arm64-$VERSION-api" ;;
                   unpatched) NAME="logos-blockchain-node-android-arm64-$VERSION" ;;
                   *) fail "android/node.properties: variant must be api, patched or unpatched, not '$VARIANT'" ;; esac
gh run download "$NODE_RUN" -R "$REPO_GH" -n "$NAME" -D "$WORK/dl"
[ "$(sha256 "$WORK/dl/logos-blockchain-node")" = "$NODE_SHA" ] || fail "$NAME from run $NODE_RUN doesn't match the pinned sha256"
cp "$WORK/dl/logos-blockchain-node" "$J/liblogosnode.so"

MSG_RUN=$(tr -d '[:space:]' < android/messaging-run.txt)
gh run download "$MSG_RUN" -R "$REPO_GH" -p 'logos-delivery-android-arm64-*' -D "$WORK/wdl"
W=$(ls -d "$WORK"/wdl/logos-delivery-android-arm64-* 2>/dev/null | awk 'NR==1' || true)
[ -n "$W" ] || fail "waku-build run $MSG_RUN has no messaging artifact"
while read -r sum name; do
  [ -n "$name" ] || continue
  [ "$(sha256 "$W/$name")" = "$sum" ] || fail "messaging file $name from run $MSG_RUN doesn't match android/messaging.sha256"
  if [ "$name" = waku-runner ]; then cp "$W/waku-runner" "$J/libwakurunner.so"; else cp "$W/$name" "$J/"; fi
done < android/messaging.sha256

NAMES_RUN=$(prop android/names.properties run); NAMES_SHA=$(prop android/names.properties sha256)
gh run download "$NAMES_RUN" -R "$REPO_GH" -n names-cli-android-arm64 -D "$WORK/ndl"
[ "$(sha256 "$WORK/ndl/names")" = "$NAMES_SHA" ] || fail "names from run $NAMES_RUN doesn't match the pinned sha256"
cp "$WORK/ndl/names" "$J/libnames.so"

N04_RUN=$(prop android/names04.properties run); N04_SHA=$(prop android/names04.properties sha256)
gh run download "$N04_RUN" -R "$REPO_GH" -n names04-cli-android-arm64 -D "$WORK/n04dl"
[ "$(sha256 "$WORK/n04dl/names")" = "$N04_SHA" ] || fail "names (LEZ 0.4) from run $N04_RUN doesn't match the pinned sha256"
grep -q ', bare, ' "$WORK/n04dl/BUILD.txt" || fail "the pinned LEZ 0.4 signer is not the bare build"
cp "$WORK/n04dl/names" "$J/libnames04.so"

# ---- 4. build ------------------------------------------------------------------------------------------------------
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-${TMPDIR:-/tmp}/logos-release-gradle-home}
mkdir -p "$GRADLE_USER_HOME"
GRADLE=$(command -v gradle || true)
GV=$([ -n "$GRADLE" ] && "$GRADLE" --version 2>/dev/null || true)
if ! printf '%s\n' "$GV" | grep -qx "Gradle $GRADLE_VERSION"; then
  G="$GRADLE_USER_HOME/dist/gradle-$GRADLE_VERSION"
  if [ ! -x "$G/bin/gradle" ]; then
    say "== downloading Gradle $GRADLE_VERSION into $GRADLE_USER_HOME/dist"
    mkdir -p "$GRADLE_USER_HOME/dist"
    Z="$GRADLE_USER_HOME/dist/gradle-$GRADLE_VERSION-bin.zip"
    curl -fsSL -o "$Z" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
    want=$(curl -fsSL "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip.sha256" | tr -d '[:space:]')
    [ "$(sha256 "$Z")" = "$want" ] || { rm -f "$Z"; fail "the Gradle download doesn't match its published sha256"; }
    unzip -q -o "$Z" -d "$GRADLE_USER_HOME/dist" && rm -f "$Z"
  fi
  GRADLE="$G/bin/gradle"
fi
say "== testReleaseUnitTest assembleRelease (node $VERSION, $VARIANT)"
(cd android && "$GRADLE" --no-daemon testReleaseUnitTest assembleRelease \
  -PnodeVersion="$VERSION" -PnodeSha256="$NODE_SHA" -PnodeVariant="$VARIANT")

# ---- 5. check the APK ----------------------------------------------------------------------------------------------
A=android/app/build/outputs/apk/release/app-release.apk
[ -f "$A" ] || fail "no $A"
SIGN=$("$BT/apksigner" verify --print-certs "$A") || fail "apksigner doesn't accept the APK's signature"
say "$SIGN"
GOT_CERT=$(printf '%s\n' "$SIGN" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | awk 'NR==1')
[ "$(printf '%s\n' "$SIGN" | grep -c '^Signer #[0-9]* certificate SHA-256 digest')" = 1 ] || fail "the APK has more than one signer"
[ "$GOT_CERT" = "$RELEASE_CERT" ] || fail "the APK is signed with $GOT_CERT, not the release key ($RELEASE_CERT)"
[ "$GOT_CERT" != "$DEBUG_CERT" ] || fail "the APK is signed with the public debug key"
"$BT/aapt2" dump badging "$A" > "$WORK/badging.txt"
! grep -q 'application-debuggable' "$WORK/badging.txt" || fail "the APK is debuggable"
"$BT/aapt2" dump xmltree --file AndroidManifest.xml "$A" > "$WORK/manifest.txt"
! grep -q 'debuggable(0x0101000f)=true' "$WORK/manifest.txt" || fail "the APK's manifest says debuggable"
in_apk() { [ "$(unzip -p "$A" "$1" | sha256_stdin)" = "$2" ] || fail "$1 is missing from the APK or differs from $3"; }
in_apk lib/arm64-v8a/liblogosnode.so "$NODE_SHA" "the pinned $VARIANT node"
while read -r sum name; do
  [ -n "$name" ] || continue
  [ "$name" = waku-runner ] && f=libwakurunner.so || f=$name
  in_apk "lib/arm64-v8a/$f" "$sum" "the pinned $name"
done < android/messaging.sha256
in_apk lib/arm64-v8a/libnames.so "$NAMES_SHA" "the pinned names build"
in_apk lib/arm64-v8a/libnames04.so "$N04_SHA" "the pinned names04 build"
for f in server.py index.html release.json names/names.js names/lookup.js messages/messages.js qr/qrcode.js lns/lns.js \
         lez04.py lez04.json signer04.py net04/net04.js net04/sign04.js net04/nft.js net04/fonts/Gloock-Regular.ttf net04/fonts/FiraCode-VF.ttf; do
  in_apk "assets/webapp/$f" "$(sha256 "app/$f")" "app/$f"
done
VERSION_NAME=$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" "$WORK/badging.txt" | awk 'NR==1')
mkdir -p "$OUT"
NAME_OUT="logos-node-$VERSION_NAME-node$VERSION-$VARIANT-release.apk"
cp "$A" "$OUT/$NAME_OUT"
(cd "$OUT" && { if command -v sha256sum >/dev/null; then sha256sum "$NAME_OUT"; else shasum -a 256 "$NAME_OUT"; fi; } > "$NAME_OUT.sha256")
{ echo "commit $COMMIT"; echo "signer certificate SHA-256 $RELEASE_CERT"; echo "not debuggable; pinned binaries and web app checked"; } > "$OUT/$NAME_OUT.txt"
say "== done: $OUT/$NAME_OUT"
say "   commit $COMMIT, signed by certificate SHA-256 $RELEASE_CERT, not debuggable"
cat "$OUT/$NAME_OUT.sha256"
