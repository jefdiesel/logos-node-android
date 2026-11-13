# Native Android build of the Logos Messaging (Waku) node

This builds the official Logos Messaging node library, `liblogosdelivery`, from
[logos-messaging/logos-delivery](https://github.com/logos-messaging/logos-delivery) (the Nim
node formerly called nwaku), for Android arm64 (`aarch64-linux-android`, API 28). It uses
upstream's own make target, `liblogosdelivery-android-arm64`, which upstream's CI also builds.
The source is used as published: no patches, no fork.

**Version: v0.40.0-rc.3** (commit `57e04dc4473aec7a36e4be5f025697b477a6562a`), a release
candidate. That is acceptable on a testnet. It is needed because v0.39.2, the latest stable
release, ignores `--shard` and relays all 8 shards; see "Traffic" below.

Upstream supports Android only as a library: there is no Android target for the
`logosdeliverynode` command-line node. So this directory adds a small runner,
`runner/waku_runner.c`, that turns the library into a process the app can start, the same way it
starts the blockchain node. The runner uses only the library's public C API.

The build runs only in GitHub Actions (`.github/workflows/waku-build.yml`), on every push that
touches `messaging/**` or that workflow. The result is kept as a workflow artifact
(`logos-delivery-android-arm64-<version>`) and is not published anywhere else. A build from
scratch takes about 8 minutes. When only the runner changes, the cached library is reused.
Builds of the same source are not byte-for-byte reproducible, so pin the hashes of one specific
run.

## Files in the artifact

| File | Size (stripped) | Needs |
| --- | --- | --- |
| `waku-runner` | 47 KB | `liblogosdelivery.so` (found next to it, `RUNPATH=$ORIGIN`), `liblog.so`, libc, libdl |
| `liblogosdelivery.so` | 36 MB | `liblog.so`, libc, libm, libdl (libc++ is static) |

- `include/`: the C headers (`liblogosdelivery.h` and `generated/`), for calling the library
  directly, for example through JNI, instead of through the runner.
- `logos-test.json`, `logos-test-rest.json`, `logos-test-socket.json`: the recommended configuration,
  without REST, with REST on TCP, and with REST off for the runner's own API socket (what the app uses).
- `SHA256SUMS`, `VERSION`.

v0.39.2 also needed `librln.so`. Upstream's Android task linked it even with RLN compiled out,
and the runner then had to run with `LD_LIBRARY_PATH` set. The rc3 library asks only for system
libraries, so `librln.so` is no longer shipped. The workflow ships it again automatically if a
version needs it.

## How it works

1. `make build-deps`, then `make liblogosdelivery-android-arm64 ANDROID_TARGET=28` in the upstream
   checkout, with the NDK that upstream's CI uses (r27c).
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

Change `WAKU_VERSION` and `WAKU_SHA` in `.github/workflows/waku-build.yml` (the tag and the
commit it points to; the build fails if they disagree), and the `workflow_dispatch` default, then
push. You can also run the workflow by hand with any tag or commit sha.

## The runner's own API on a Unix socket

The library's REST server listens on TCP, and on a phone every installed app can connect to
127.0.0.1: another app could read and empty the received-message buffer (`GET
/messaging/v1/events/received` clears what it returns), publish, and drop the wallet's
subscriptions. So the app runs the node with `"rest": false` and the runner serves the calls the
wallet makes itself, on a Unix socket (`--api-socket PATH`, `runner/api_socket.h`):

| Call | Answer |
|---|---|
| `GET /health` | `{"nodeHealth":"Ready","connectionStatus":"<the library's status>"}` |
| `GET /messaging/v1/subscriptions` | the content topics subscribed through this socket, sorted |
| `POST` / `DELETE /messaging/v1/subscriptions` | `["topic", ...]`: subscribe / unsubscribe |
| `POST /messaging/v1/messages` | the message JSON as the library's `send` takes it; `{"requestId":"..."}` |
| `GET /messaging/v1/events/received` | `[{"seq":N, ...the onMessageReceived event...}, ...]`, then cleared |
| `GET /messaging/v1/events/send/<requestId>` | `{"requestId":"..","events":[{"kind":"propagated"},{"kind":"sent"}]}` (or `"error"` with its text, `"queued"`), then removed; 404 if none |

These are the same paths and answers as the library's REST API at the pinned commit
(`rest/messaging_api`), evict-after-poll included, built from the same events, so a client
changes only its transport. Between polls the runner keeps up to 256 request ids, and up to 256
received messages **and at most 2 MiB of them** (their JSON records), dropping the oldest first (the
gap shows in `seq`). The byte bound keeps every answer to `GET /messaging/v1/events/received` below
what the wallet reads in one go (16 MiB over the socket; 4 MiB on the old TCP path): an answer it had to cut short would lose the whole batch,
already dropped here. A message on logos.test is at most 150 KiB (about 200 KB as base64 JSON), so
at least 10 of the largest fit. A flood of large messages to the inbox topic can still push older
ones out before a poll (as upstream's own 50-message cache can); they are counted as missed.

- **Where:** the path must be absolute, in a real directory (not a symlink) owned by the runner's
  user with no group or other access; the socket is created under umask 077 and set to 0600. A
  socket left by an earlier run is removed only if nothing answers on it; a live socket (another
  runner) or any other file is left alone. If the socket can't be opened the runner stops the
  node and exits: there is no other way in.
- **Config:** with `--api-socket` the runner refuses to start if its config could turn on any of
  the library's network APIs: `rest`, `rest-admin`, `metrics-server`, `websocket-support`,
  `websocket-secure-support`. Keys are compared as the library reads them (case-insensitive, by
  option or field name, so `REST`, `restAdmin`, `metrics_server` count too), any key written with a
  backslash escape is refused, and for those keys any value other than `false` or `null` is refused
  (the library takes `1`, `"true"`, `"yes"`, `"on"` as true). The app writes `"rest": false` and none
  of the others (all default to off).
- **Limits:** headers up to 16 KB, bodies up to 1 MB, 16 connections at once, 15 s to send or
  receive, one request per connection (`Connection: close`).
- **Logging:** with the socket, the received messages are no longer printed in full to the log,
  only that one came; send events still are.
- **Tests:** `runner/test_api_socket.py` builds `runner/api_socket_harness.c` (the same code with a
  stand-in library) on the build machine and checks all of the above; the `waku-build` workflow runs
  it before building for Android. The runner with the real library has not run on a phone yet.

## Running it

```
waku-runner <config.json> [--duration SEC] [--status-every SEC] [--topic CONTENT_TOPIC] [--send-every SEC] [--api-socket PATH]
```

The runner logs to stdout. It prints the node's identity, then a status line at each interval:
connection status, connected peers, RSS, and some relay and traffic metrics. On SIGINT or SIGTERM
it stops the node and exits.

On v0.39.2 the library's `stop_node` never answered (the runner waits 15 seconds for it),
`destroy` then reported the context as quarantined, and the process exited about 20 seconds after
the signal. This is not yet checked on rc3. Allow 25 seconds, then kill the process.

### Configuration (recommended)

```json
{
  "mode": "Core",
  "preset": "logos.test",
  "shard": [7],
  "filter": false,
  "lightpush": false,
  "nat": "none",
  "tcp-port": 60000,
  "discv5-udp-port": 9000,
  "rest": true,
  "rest-address": "127.0.0.1",
  "rest-port": 18645,
  "nodekey": "<64 hex digits, generated once and kept private>",
  "local-storage-path": "<app data directory>"
}
```

What each setting does:
- Relay node (`Core`) on `logos.test` (cluster 2, 8 auto-shards, RLN off), relaying **shard 7
  only**.
- Filter and lightpush serving off; peer discovery left at its defaults.
- NAT port mapping off (`"nat": "none"`), so the node never asks the router to open ports.
- REST on loopback only.

The node keeps a small SQLite database in `local-storage-path`. With a fixed `nodekey` it keeps
the same peer id across restarts. The runner never prints the configuration, but the library logs
it, key included, when it fails to parse it. So check the configuration before passing it on.

Ports: TCP 60000 and QUIC UDP 60000 (libp2p), UDP 9000 (discv5), TCP 18645 on 127.0.0.1 (REST).

**This must be the flat shape.** The library accepts two configuration shapes:
- **Structured:** `mode`, `preset`, `messagingOverrides`, as documented in upstream's
  `library/README.md`. Its `messagingOverrides` has no `shard`, `rest*`, `filter` or `lightpush`
  key. With it the node relays every shard.
- **Flat:** node options at the top level, as above. This is the only way to set those options.
  Upstream marks the flat shape as legacy (see `upstream-drafts/02-…`).

### Shards and topics

Auto-sharding puts a content topic `/<app>/<version>/<name>/<encoding>` on shard
`sha256(<app> + <version>)` mod 8. The name part does not count. **So every `/names/1/.../proto`
topic, and therefore every LNS inbox, is on shard 7.**

On rc3:
- **Receiving:** subscribing to a content topic on another shard makes the relay join that shard
  too, so the node then pays for that shard's traffic.
- **Sending:** to a topic on another shard works without joining it. Relay publishes to the peers
  on that shard and falls back to lightpush.

### Health

`connectionStatus` (from `/health` and the runner's status line) comes from the **smallest relay
mesh across all subscribed shards**: `Connected` needs at least 4 mesh peers, `PartiallyConnected`
at least 1. It can therefore say `PartiallyConnected` or `Disconnected` while messages flow:
- when a subscribed topic lives on a shard nobody else uses;
- with peer discovery turned off (7 to 17 peers), even though 100 or more messages a minute were
  arriving.

Do not treat it alone as "offline".

## Traffic

Measured on 2026-11-12, on `logos.test`, with the official macOS node releases on a desktop.
Each figure is a single 3–4 minute window. **The network load swung about 2x within one
afternoon**, so read these as rough sizes, not constants.

| Version | Configuration | Peers | MB/min in / out | GB/day in / out |
| --- | --- | --- | --- | --- |
| v0.39.2 | Core, all shards | 48 | 70.5 / 76.6 | 101 / 110 |
| v0.39.2 | Core, `shard: [5]` (ignored, still relays all shards) | 48 | 46.8 / 34.8 | 67 / 50 |
| v0.39.2 | as above, discovery and filter/lightpush/mix off | 17 | 24.7 / 7.1 | 36 / 10 |
| v0.40.0-rc.3 | Core, all shards (an hour later) | 46 | 30.2 / 16.5 | 43 / 24 |
| **v0.40.0-rc.3** | **Core, shard 7** | 45 | **0.51 / 0.56** | **0.73 / 0.81** |
| v0.40.0-rc.3 | Core, shard 7, filter/lightpush off | 44 | 0.57 / 0.45 | 0.82 / 0.65 |
| v0.40.0-rc.3 | Core, shard 7, discovery off too | 7 | 0.08 / 0.04 | 0.12 / 0.06 (status `Disconnected`) |
| v0.40.0-rc.3 | Edge, one subscription (light client, for comparison) | 44 | 0.32 / 0.04 | 0.46 / 0.06 |

Notes:
- **Phone check:** on the phone, v0.39.2 on all shards measured 49 / 31 MB/min over 16 minutes,
  in line with the desktop.
- **Cause:** v0.39.2 subscribes the relay to every auto-sharding shard at start-up, whatever
  `--shard` says. Upstream fixed this in
  [PR #4513](https://github.com/logos-messaging/logos-delivery/pull/4513) ("make --shard limit
  the relay shards under autosharding"), after v0.39.2.
- **Where the load was:** that day, shard 1 (several `/scala/1/<id>/json` topics, 8–24 KB
  messages, 60% of the bytes) and shard 6 (one topic, `/lez-atomic-swaps/1/offers/json`, 33%).
  Shard 7 carried about 130 small messages a minute.
- **What the relay adds:** forwarding, with gossipsub's fixed mesh degree of 6, adds upload on top
  of download.
- **Discovery:** Kademlia used about 0.13 MB/min.
- **Expected cost of the recommended configuration:** about 0.5–0.6 MB/min each way, roughly
  **1.5 GB/day** at the shard-7 load measured. It grows if other applications that hash to shard 7
  get busier.
- **`--max-connections`:** a value of 10 crashes rc3 at start-up (see `upstream-drafts/01-…`);
  20 works.

## Tested on a device (v0.39.2)

One phone, a Pixel 8 on Android 17, run from the adb shell as the `shell` user in
`/data/local/tmp`, on `logos.test` with v0.39.2. These runs used the libraries of build run
43239037351. The runner (sha256 `81eea7cb…`, unchanged since) was run for one minute with the
then-default config: it connected to 28 peers and stopped cleanly. `phone-test.sh` is the script
for such a run.

- The node started in under a second, was `Connected` within 20 seconds and kept 40 to 46 peers.
- It relayed about 31,000 gossip messages from peers in 16 minutes. Test messages it published
  to a topic of our own were reported as propagated.
- Memory (RSS): about 130 MB after 1 minute, 142 MB after 5, 168 MB after 15, and a peak of
  178 MB. It was still rising slowly when the run ended.
- REST on `127.0.0.1:18645` (flat config): `/health`, `/debug/v1/version`, `/debug/v1/info`
  and `/messaging/v1/subscriptions` answered.
- Under relay load the event loop sometimes lagged: 2 of 17 `/health` probes got no answer within
  5 seconds.

On a desktop, an rc3 relay node on shard 7 and a v0.39.2 Edge node exchanged messages on
`/names/1/msg-…/proto` topics, both live and after the receiver had been offline:
- **Live:** delivered both ways, with `propagated` then `sent` reported for each send.
- **Receiver offline:** the message arrived as `history`. The v0.39.2 Edge receiver had it within
  45 seconds of subscribing. The rc3 relay receiver took 60–80 seconds.
- **Duplicates:** both nodes also delivered some earlier messages a second time, as `history`. A
  client should de-duplicate by message hash, and ignore its own sends, which also show up in
  `/messaging/v1/events/received`.

## Not verified

- **rc3 on the phone:** the build itself, the runner starting without `LD_LIBRARY_PATH`,
  `"shard": [7]` through the library, and whether `stop_node` answers.
- Running inside an app sandbox, or loading the library in-process through JNI.
- Long runs, memory after an hour, battery use, and behaviour across network changes and the
  phone sleeping.
- How shard 7's load changes over days.
- Any other phone, Android version or CPU.
