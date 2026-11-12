# Native Android build of the Logos Messaging (Waku) node

This builds the official Logos Messaging node library, `liblogosdelivery`, from
[logos-messaging/logos-delivery](https://github.com/logos-messaging/logos-delivery) (the Nim
node formerly called nwaku) at a tagged release, for Android arm64 (`aarch64-linux-android`,
API 30). It uses upstream's own make target, `liblogosdelivery-android-arm64`, the one upstream's
CI builds on every change. The source is used as published: no patches, no fork.

Upstream supports Android only as a library (there is no Android target for the
`logosdeliverynode` command-line node), so this directory adds a small runner,
`runner/waku_runner.c`, that turns the library into a process the app can start the same way it
starts the blockchain node. The runner uses only the library's public C API.

The build runs only in GitHub Actions (`.github/workflows/waku-build.yml`), on every push that
touches `messaging/**` or that workflow. The result is kept as a workflow artifact
(`logos-delivery-android-arm64-<version>`) and is not published anywhere else.

## Files in the artifact

- `waku-runner`: the runner (finds the two libraries next to itself through `RUNPATH=$ORIGIN`).
- `liblogosdelivery.so`: the node.
- `librln.so`: zerokit RLN, which the node links (RLN is off on `logos.dev`, but the library
  needs it to load).
- `include/`: the C headers, for calling the library directly (e.g. through JNI) instead.
- `logos-dev.json`: the configuration used for testing.

## How it works

1. `make build-deps`, then `make liblogosdelivery-android-arm64` in the upstream checkout, with
   the NDK upstream's CI uses (r27c). This cross-compiles librln with `cross` and the node with
   Nim and the NDK clang.
2. Two build flags are added through upstream's `NIMFLAGS` variable, listed in `nimflags`:
   - logging: INFO level to stdout. Upstream's Android task compiles in ERROR level to a
     `dynamic` log sink that only an embedding app would configure. The log level is fixed at
     compile time.
   - the generated C header (`library/generated/logosdelivery.h`), which upstream's host
     library build emits and the Android task does not.
3. `build-runner.sh` compiles the runner and TinyCBOR (used by the header's typed helpers) with
   the NDK clang.

## Building a newer version

Change `v0.39.2` in `.github/workflows/waku-build.yml` (the `WAKU_VERSION` default and the
`workflow_dispatch` default) and push, or run the workflow by hand with a tag or a commit sha.

## Running it

```
waku-runner <config.json> [--duration SEC] [--status-every SEC] [--topic TOPIC] [--send-every SEC]
```

The configuration is upstream's JSON node configuration (`mode`, `preset`, `messagingOverrides`;
see `library/README.md` upstream). `logos-dev.json` joins the `logos.dev` network (cluster 3, 8
auto-shards, RLN off) as a relay node and turns NAT port mapping off so the node never asks the
router to open ports.
