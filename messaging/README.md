# Native Android build of the Logos Messaging (Waku) node

This builds the official Logos Messaging node library, `liblogosdelivery`, from
[logos-messaging/logos-delivery](https://github.com/logos-messaging/logos-delivery) (the Nim
node formerly called nwaku) at a tagged release, for Android arm64 (`aarch64-linux-android`,
API 28). It uses upstream's own make target, `liblogosdelivery-android-arm64`, which upstream's
CI also builds. The source is used as published: no patches, no fork.

Upstream supports Android only as a library: there is no Android target for the
`logosdeliverynode` command-line node. So this directory adds a small runner,
`runner/waku_runner.c`, that turns the library into a process the app can start, the same way it
starts the blockchain node. The runner uses only the library's public C API.

The build runs only in GitHub Actions (`.github/workflows/waku-build.yml`), on every push that
touches `messaging/**` or that workflow. The result is kept as a workflow artifact
(`logos-delivery-android-arm64-<version>`) and is not published anywhere else. A build from
scratch takes about 8 minutes. When only the runner changes, the cached library is reused.

## Files in the artifact

| File | Size (stripped) | Needs |
| --- | --- | --- |
| `waku-runner` | 47 KB | `liblogosdelivery.so`, `liblog.so`, libc, libdl |
| `liblogosdelivery.so` | 35 MB | `librln.so`, `liblog.so`, libc, libm, libdl (libc++ is static) |
| `librln.so` | 6.4 MB | libc, libm, libdl |

- `include/`: the C headers (`liblogosdelivery.h` and `generated/`), for calling the library
  directly, for example through JNI, instead of through the runner.
- `logos-test.json`, `logos-test-rest.json`: the test configurations (below).

`librln.so` is still needed, although RLN is compiled out (`-d:disable_rln`). With RLN off the
node uses none of its symbols, but upstream's Android task always links `-lrln`, so the loader
still asks for it.

## How it works

1. `make build-deps`, then `make liblogosdelivery-android-arm64 ANDROID_TARGET=28` in the upstream
   checkout, with the NDK that upstream's CI uses (r27c). This cross-compiles librln with `cross`
   and the node with Nim and the NDK clang.
2. Extra Nim flags go through upstream's `NIMFLAGS` variable and are listed in `nimflags`:
   - logging at INFO level to stdout. Upstream's Android task compiles in ERROR level and sends
     it to a `dynamic` log sink that only an embedding app would configure. The log level is
     fixed at compile time;
   - the generated C header (`library/generated/`), which upstream's host build writes and its
     Android task does not;
   - `-d:disable_rln`, as upstream's own host library build does. Both Logos presets have RLN off.
3. `build-runner.sh` compiles the runner and TinyCBOR (used by the header's typed helpers) with
   the NDK clang.

## Building a newer version

Change `v0.39.2` in `.github/workflows/waku-build.yml` (the `WAKU_VERSION` default and the
`workflow_dispatch` default) and push. You can also run the workflow by hand with a tag or a
commit sha.

## Running it

```
LD_LIBRARY_PATH=<dir of the .so files> waku-runner <config.json> \
    [--duration SEC] [--status-every SEC] [--topic CONTENT_TOPIC] [--send-every SEC]
```

`LD_LIBRARY_PATH` is required. The runner finds `liblogosdelivery.so` next to itself
(`RUNPATH=$ORIGIN`), but `liblogosdelivery.so` has no RUNPATH and `librln.so` has no SONAME, so
Android's linker can only find `librln.so` on the search path. An app that starts the runner as a
child process sets this variable to its native library directory.

The runner logs to stdout. It prints the node's identity, then a status line at each interval:
connection status, connected peers, RSS, and some relay and traffic metrics. On SIGINT or SIGTERM
it stops the node and exits. Allow about 35 seconds: in every test, the library's `stop_node`
never answered within its timeout, and `destroy` then reported the context as quarantined. The
process still exited normally.

### Configuration

The configuration is the library's JSON (see `library/README.md` upstream). It comes in two
shapes:

- **Structured** (`logos-test.json`): `mode`, `preset`, `messagingOverrides`. This is the
  documented shape. `messagingOverrides` accepts only messaging-level keys, such as ports, `nat`,
  `nodekey`, `local-storage-path`, `log-level` and the store and rate-limit settings. It rejects
  `rest*`, `filter`, `lightpush` and `shard`.
- **Flat** (`logos-test-rest.json`): `mode` and `preset` plus any node option at the top level,
  including `rest`, `rest-address`, `rest-port`, `filter`, `lightpush` and `shard`. Upstream
  marks this shape as legacy, kept for compatibility.

Both test configurations join `logos.test` (cluster 2, 8 auto-shards, RLN off) as a Core
(relay) node. They turn NAT port mapping off (`"nat": "none"`), so the node never asks the router
to open ports. Add `"nodekey": "<64 hex>"` to keep the same peer id across restarts. Keep that
file private and do not log it. The node keeps a small SQLite database in `local-storage-path`.

## Tested on a device

One phone, a Pixel 8 on Android 17, run from the adb shell as the `shell` user in
`/data/local/tmp`, `logos.test`, v0.39.2, with the artifact of build run 43239037351 (checksums in
its `SHA256SUMS`). `phone-test.sh` is the script for such a run.

- `--version` printed `v0.39.2`.
- The node started in under a second, was `Connected` within 20 seconds and kept 40 to 46 peers.
  `/health` reported `nodeHealth: READY` with Relay, Filter and Lightpush `READY`.
- The node relayed: it validated about 31,000 gossip messages from peers in 16 minutes.
  Test messages it published to a topic of our own (`/logos-node-android/1/waku-runner-test/proto`,
  shard 5) were reported as propagated. Later runs received those same messages back from the
  network.
- Memory (RSS): about 130 MB after 1 minute, 142 MB after 5, 168 MB after 15, and a peak of
  178 MB. It was still rising slowly when the run ended.
- **Traffic is high.** On `logos.test` as it was during the test, relaying all 8 shards used
  about 785 MB down and 500 MB up in 16 minutes (about 2.9 GB/h down, 1.8 GB/h up). The phone's
  Wi-Fi counters agreed. Relaying shard 5 only (flat config, `"shard": [5]`) still used about
  33 MB/min down. Most of this is other people's traffic on the network, relayed through the
  phone.
- REST (flat config, `127.0.0.1:18645`): `/health`, `/debug/v1/version`, `/debug/v1/info` and
  `/messaging/v1/subscriptions` answered. `/admin/v1/peers` returned nothing (admin endpoints are
  off by default). With `"filter": false, "lightpush": false` those two protocols were not
  mounted, and relay kept working.

## Not verified

- Running inside an app sandbox, or loading the library in-process through JNI.
- Long runs, memory after an hour, battery use, and behaviour across network changes and the
  phone sleeping.
- Messages from another person's node arriving on the phone. Our own messages came back from the
  network, but no second client was used.
- Any other phone, Android version, CPU, or network (`logos.dev` was not run).
