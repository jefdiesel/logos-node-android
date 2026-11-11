# Native Android build of the Logos node

This builds the official Logos blockchain node (`logos-blockchain-node` from
[logos-blockchain/logos-blockchain](https://github.com/logos-blockchain/logos-blockchain)) at a
tagged release, compiled for Android arm64 (`aarch64-linux-android`, API 28) with the Android NDK.
The node source is used as published: no patches, no fork. The result is one executable that needs
only the system's `libc.so`, `libm.so` and `libdl.so`.

The build runs only in GitHub Actions (`.github/workflows/native-build.yml`). It runs on every
push that touches `native/**` or that workflow file, and the binary is kept as a workflow
artifact (`logos-blockchain-node-android-arm64-<version>`). It is not published anywhere else.

## How it works

1. The node needs four ZK witness-generator libraries (pol, poq, signature, poc) that upstream only
   publishes for Linux, macOS and Windows. `build-circuits.sh` compiles them for Android with the
   NDK, following the exact recipe of upstream's own CI (same circom version, same patches, same
   symbol hiding). It checks that the generated `witness_generator.dat` files are byte-identical to
   the official release.
2. The proving and verification keys are copied unchanged from the official circuits release. They
   are tied to that release and must never be regenerated.
3. The prover library (rapidsnark) comes from iden3's prebuilt Android archive, as the node's own
   dependency already does; its GMP is reused for the witness generators so there is one GMP.
4. The node is then built with plain `cargo build --target aarch64-linux-android --release`, using
   the NDK's API-28 clang as compiler and linker and the node's own release profile. The C++
   runtime (libc++) is linked statically.

## Building a newer node version

Change `0.3.4` to the new tag in `.github/workflows/native-build.yml` (the `NODE_VERSION` default
and the `workflow_dispatch` default) and push. The circuits tag, rapidsnark version, circom version
and Rust toolchain are read from the node's own sources. If the new release adds or moves a
circuit, update the list at the bottom of `build-circuits.sh`. The NDK version is pinned as
`NDK_VERSION` in the workflow.

## Tested on a device

One phone, a Pixel 8 on Android 17, for a few minutes, run from the Android shell over adb
(`/data/local/tmp`, as the `shell` user), with the artifact of build run 43110642895
(sha256 `454c822316af62c16cee2e188622cd4ea2d4eff23b38538e98983d14121c05c2`):

- `--version` printed `logos-blockchain-node 0.3.4 … target: aarch64-linux-android`.
- Started with a testnet config (fresh keys from `init-config`, the four testnet initial peers as
  IP multiaddrs, swarm on UDP 3010, API on 127.0.0.1:18180), it connected to 129 peers and synced
  from block 0 to 1,568 in about two and a half minutes (roughly 900 blocks a minute) at 211 MB
  RSS, with no netlink, permission or `resolv.conf` errors. It was then stopped.

Device note: Android's `sh` could not create a here-document under `/data/local/tmp` without a
usable `TMPDIR`, so write config files on the computer and `adb push` them.

## Not verified

- Running inside an app sandbox (only the adb shell user was tried).
- Proof generation (leader proofs, wallet signatures) on the device.
- A long run, a full sync, or behaviour across network changes and the phone sleeping.
- Any other phone, Android version or CPU.
