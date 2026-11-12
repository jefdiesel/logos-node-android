# Logos node: Android app (test build)

An Android app that runs the official Logos node on the phone and shows the project's own wallet page.
It is a debug build for testing, not something to publish.

- Package `io.github.jefdiesel.logosnode`, name "Logos node", arm64 phones only, Android 9 (API 28)
  or newer.
- **The node** is the binary from the `native-build` workflow (see `native/README.md`), bundled as it
  is, not rebuilt. The APK carries it as `lib/arm64-v8a/liblogosnode.so`. Android extracts that at
  install to the app's native library folder, the only place it lets an app run programs from.
- **The wallet** is the repository's web app, `app/`, at build time: its own `server.py`, `index.html`
  and `names/`. They are shipped unchanged as assets, and `server.py` runs inside the app on
  Python 3.12, through Chaquopy (MIT licence). There is one codebase for both routes, the Linux
  Terminal install and this app.

## Screens

- **Wallet**, which opens first: the web app's page in a WebView. It shows the node's status, and
  the wallet with PIN, accounts, send, history, backup, restore, settings and LNS names. A bar at the
  top has a **Node** button.
- **Node**, reached with that button:
  - Start and Stop.
  - Whether the node process is running, and its memory.
  - The node's height, state, phase and peer count, read from its API.
  - Whether the wallet server is answering, and if it isn't, why.
  - **Start from a snapshot**, and **Go back to the previous state** (see below).
  - The last 40 lines of the node's log.

## How it runs

- **The node** runs in a foreground service of type `specialUse` in the app's main process. That is
  the only foreground type with no time limit; `dataSync`, for one, is capped at 6 hours a day on
  Android 15 and later. The service:
  - shows a permanent notification
  - starts the node as a child process, through the link `files/node/logos-blockchain-node`, so
    the node's command line carries its usual name, which the web app looks for
  - restarts the node after 5 s if it exits. The wait doubles up to 5 minutes, and goes back to
    5 s after a run of more than 10 minutes.
  - stops it on Stop: SIGTERM, then SIGKILL after 20 s
  - holds a partial wake lock while the node runs
- **On first start**, the service runs the node's own `init-config`, which creates fresh keys. It
  then writes `user_config.yaml` in the same shape as `install.sh`: the four testnet initial peers,
  the API on `127.0.0.1:18180`, and log and state folders inside the app.
- **What a restart costs.** Each start, the node first replays its saved blocks since the last
  final block (LIB), at about 30 blocks a second on a Pixel 8. That is about 1,000 blocks, around
  30 s, once the node has been Online. Then it goes Online, but only after
  `cryptarchia.service.bootstrap.prolonged_bootstrap_period` has passed, which is 1 hour by default
  and starts again from zero at every start. The wait is skipped only if the node was Online when
  it stopped and was off for less than `offline_grace_period.grace_period`, which is 20 minutes by
  default. The node saves its "was Online" mark at the switch and then every
  `state_recording_interval`, 1 minute by default.

  The app's config writer can set both:
  - in code, through `PROLONGED_BOOTSTRAP_PERIOD` and `GRACE_PERIOD` in `NodeFiles.kt`, which are
    null for now, so the node's defaults apply
  - on one phone, through `files/node/bootstrap.txt`, with lines `prolonged_bootstrap_period=60s`
    and `grace_period=24h`

  Durations look like `60s`, `20m` or `24h`. A new APK always restarts the node, and
  `adb install -r --dont-kill` doesn't change that, so batch installs.
- **The wallet server**, `server.py`, runs in a separate process, `:wallet`, together with the
  wallet screen. Whatever happens there cannot take the node down. It listens on
  `127.0.0.1:18190`; the Linux Terminal route uses 8090, so both fit on one phone. The app sets
  the environment, imports `server.py` as a module and runs its `main()` in a thread
  (`logos_embed.py`). It keeps the module, so it can call `server.native_unlock()` in the same
  process. The settings:

  | setting | value |
  |---|---|
  | `APP_EMBEDDED` | `android`: the web app's Android mode (0.7.6 and later) |
  | `NODE_API` | `http://127.0.0.1:18180` |
  | `NODE_BIN` | the link above |
  | `NODE_CFG` | `files/node/user_config.yaml` |
  | `APP_DATA` | `files/wallet` |
  | `APP_PORT` | `18190` |
  | `NODE_RESTART_CMD` | `pkill -TERM -f '<node> user_config.yaml'`; the service then restarts the node |

  In the Android mode the web app doesn't update or restart itself; updates come with a new APK, and
  Settings says so. The texts about passkeys and localhost are hidden. Fingerprint unlock goes
  through the phone's own check (below).

- **Fingerprint unlock.** The page's fingerprint button calls
  `window.LogosAndroid.unlockWithFingerprint()`. That interface exists only on the wallet's WebView,
  which loads only `http://127.0.0.1:18190`, and every call checks the page's address first. The
  app then:
  1. asks the wallet (`GET /api/wallet`) whether fingerprint unlock is on, and refuses without a
     prompt if it isn't
  2. shows Android's fingerprint prompt, with strong biometrics only. There is no screen-lock PIN
     fallback; the wallet's own PIN is the fallback.
  3. on success, calls `server.native_unlock()` in-process. There is no HTTP route for it.
  4. hands the session token to the page with `window.logosNativeUnlocked(token)`. Otherwise it
     calls `window.logosNativeUnlockFailed(message)` with the reason.

  The token is never logged. The check is bound to an Android Keystore key that needs a strong
  biometric for each use and is invalidated when a fingerprint is added or removed. If that
  happens, the app turns fingerprint unlock off, and the wallet PIN is needed to turn it on again.
  The key is made when the page shows fingerprint unlock is on, and deleted when it is off.
  Turning it on or off happens in the page's Settings, and turning it on needs the PIN.

- **Network.** Cleartext HTTP is allowed to `127.0.0.1` and `localhost` only
  (`network_security_config.xml`). The wallet server itself makes HTTPS requests to the LNS
  sequencer for name lookups, as on Linux.

## Files on the phone

Everything is in the app's private storage, `/data/data/io.github.jefdiesel.logosnode/files/`.

The node's files are in `node/`:

| path | what |
|---|---|
| `node/output.log` | the node's stdout and stderr, plus `[app]` lines from the service. Capped at 4 MB, then moved to `output.log.1` |
| `node/logs/` | the node's own hourly log files; the node keeps 10 |
| `node/state/` | the node's database |
| `node/user_config.yaml`, `node/keystore.yaml` | the config and the node's keys |
| `node/state.previous/` | the state before the last snapshot import or go-back |
| `node/import-status.txt` | the last import or go-back, as the Node screen shows it |

The wallet's files are kept apart from the node's, in `wallet/`:

| path | what |
|---|---|
| `wallet/wallet-pin.json`, `wallet-history.json`, `wallet-events.log`, `wallet-settings.json`, `wallet-backup.json` | the wallet's data |
| `wallet/wallet-app.log` | how the wallet started, or why it didn't, with the full error |
| `wallet/server-crash.log` | only if `server.py` itself stopped with an error |

`webapp/` holds the web app's files, copied from the APK at each new install.

The build is debuggable, so the files can be read from a computer:

```sh
adb shell run-as io.github.jefdiesel.logosnode tail -50 files/node/output.log
adb shell run-as io.github.jefdiesel.logosnode cat files/wallet/wallet-app.log
```

## Install and run from adb

```sh
adb install -r logos-node-0.3.4-debug.apk          # -r keeps the app's data, keys and database
adb shell am start -n io.github.jefdiesel.logosnode/.WalletActivity
adb shell am start-foreground-service -n io.github.jefdiesel.logosnode/.NodeService -a io.github.jefdiesel.logosnode.START
adb shell am startservice -n io.github.jefdiesel.logosnode/.NodeService -a io.github.jefdiesel.logosnode.STOP
```

The service is exported only to callers that hold `android.permission.DUMP`. The adb shell has that
permission and ordinary apps cannot get it. Stop the node before installing a new build, and start
it again after.

## Starting from a snapshot

A fresh install syncs from the first block, and that cannot finish on a phone: the node's memory
grows with the chain during the first sync. Start it from a snapshot instead. A snapshot is a tar of
a synced node's database, made as `docs/start-from-a-synced-database.md` describes: the `db/`
folder at the top of the tar. `state/db/…`, or the database files at the top, are accepted too.

On the Node screen, **Start from a snapshot** opens Android's file picker; no storage permission is
needed. After you confirm, the node's service does the import, so leaving the screen doesn't stop
it:

1. **Free space.** It checks there is about twice the snapshot's size free, and refuses otherwise.
2. **Unpacking.** It unpacks the tar as a stream into `files/node/state.importing` while the node
   keeps running. The screen shows how much has been read. It refuses:
   - links, devices, absolute paths and `..`
   - folders other than `db`
   - damaged headers and incomplete files
   - more data than there is room for

   macOS `._` metadata files are skipped.
3. **Checking.** It checks the result is a RocksDB database: `CURRENT` names a `MANIFEST-*` that
   exists, and there is at least one `.sst` table file.
4. **Swapping.** It stops the node and swaps the folders by renames only:
   - the current `state` becomes `state.previous`. Exactly one previous state is kept; an older
     one is deleted.
   - `state.importing` becomes `state`
5. **Starting.** It starts the node, even if it was stopped before. The screen then shows "The node
   is replaying N saved blocks", and after that the height.

The node's keys (`keystore.yaml`) and `user_config.yaml` are never moved or changed. If anything
fails, the state stays or is put back as it was, and the screen says why.

The swap writes a journal (`files/node/state-swap.txt`). If the app is killed in the middle, the
next start undoes the swap or finishes it, and removes a half-unpacked `state.importing`. Stop
during an import cancels it.

**Go back to the previous state** swaps `state` and `state.previous` the same way, so it can be
undone again.

On a Pixel 8, a 1 GB snapshot from block 82,820 replayed 1,000 blocks in 31 s and caught up with
the tip (84,523) in about eight minutes, at about 1 GB of memory. That run used the adb route below.

The import code (`Snapshot.kt`) is plain Kotlin. It is covered by unit tests: `SnapshotTest`, with
tars made by macOS bsdtar in default, pax and GNU format, and hand-made unsafe ones.

<details><summary>The same by hand, with adb (how it was first done)</summary>

```sh
P=io.github.jefdiesel.logosnode
adb shell am startservice -n $P/.NodeService -a $P.STOP
adb shell run-as $P mv files/node/state files/node/state.genesis
adb shell run-as $P mkdir files/node/state
adb shell "cat /sdcard/Download/logos-node/snap.tar | run-as $P sh -c 'cd files/node/state && tar xf -'"
adb shell am start-foreground-service -n $P/.NodeService -a $P.START
```

</details>

## Messaging node (Logos Messaging / Waku), off by default

The app also carries the Logos Messaging node, the official `liblogosdelivery` library with a
small runner, from the `waku-build` workflow; see `messaging/README.md`. It is not rebuilt here.

**Files.** The APK holds the files listed in `messaging.sha256`, from the waku-build run whose id is
in `messaging-run.txt`. CI checks each one against its sha256, and checks the APK copies are
byte-identical. Now that is v0.40.0-rc.3, with two files:
- `lib/arm64-v8a/libwakurunner.so`: the runner. Android installs only `lib*.so` files, so it is
  renamed.
- `lib/arm64-v8a/liblogosdelivery.so`: the library, which keeps its name because the runner loads
  it by name.

Earlier builds also carried `librln.so`; rc3 no longer needs it. To change versions, change the run
id and the sha256 lines.

**Switches.** The Node screen has a **Messaging node** switch, off by default and remembered. When
it is on, the node service runs the runner as a second child process. It has its own supervisor
(`Messaging.kt`), apart from the blockchain node and the wallet. It is stopped with SIGTERM, then
SIGKILL after 25 s, and restarted with a backoff if it exits. The process is started with:
- `LD_LIBRARY_PATH` = the app's native library folder. Earlier builds needed it for `librln.so`;
  it is kept because running without it hasn't been checked.
- `--status-every 15`

**One shard.** It relays one shard (7), without the filter and lightpush services:
`MessagingSettings.EXTRA`, in the config's flat shape (the structured shape makes rc3 relay every
shard). On the Mini that cost about 0.5 MB/min each way, against about 35/32 MB/min for a full relay.
The screen shows the rate per minute, and the node log has a "messaging: traffic …/min" line at each
reading.

**Status text.** On rc3, `connectionStatus` is the thinnest mesh among the subscribed shards. It
can say PartiallyConnected or Disconnected while messages flow, so the screen shows it as reported
("running: PartiallyConnected, 12 peers"), never as "no network".

**Where it may run.** By default it runs only on an unmetered network (Wi-Fi). If the network
becomes metered, it stops and the screen says why. **Also use mobile data** (off by default)
allows mobile data. It also stops for the day when its traffic reaches the daily cap,
`MessagingSettings.DAILY_CAP_BYTES` (2 GB).

**What the screen shows:**
- the state: starting, running with the node's status and N peers, or stopped and why
- its memory
- the bytes in and out since it started, and the current rate per minute
- today's total against the cap

These come from the runner's status lines and its `libp2p_network_bytes` metric. That counts libp2p
traffic; discovery (discv5) traffic is not in it.

**Its files** are in `files/waku/`:
- `config.json` and `nodekey`, both owner-only (0600)
- `data/`, the node's own database
- `output.log`, capped at 2 MB with one old copy
- `usage.txt`, today's traffic
- `state.txt`

**The config.**
- It is written by the app in the library's flat shape: `mode`, `preset` and the node options at
  the top level, REST on `127.0.0.1:18645`, NAT mapping off.
- It is parsed back and checked before every start, because the library logs the whole file,
  node key included, when it can't parse it.
- The node key is 32 random bytes, made once.
- Neither the key nor the config contents are ever logged. Runner output is filtered for the key.

**Settings in one place.** Every value is in `MessagingSettings`: mode, preset, ports, REST, the
status interval, the cap, the stop grace, and `EXTRA` for further flat options such as shards. The
values for a smaller relay will go in `EXTRA`.

**The wallet.** The wallet process tells the web app where the messaging node is:
- `server.set_waku_api("http://127.0.0.1:18645")` while it runs, and `set_waku_api(None)` while it
  doesn't (web app 0.8.0). Older web apps get a `WAKU_API` environment variable instead.
- This happens when the wallet starts and within a second of every change. It reads
  `files/waku/state.txt`, which the node service writes.
- Only the web app reads the node's messages; the app never polls the node's message endpoints.

**Orphan guard.** A runner nothing watches would cost gigabytes an hour. A runner counts as the
supervisor's only while it is being launched, or while the supervisor's handle is of a live process.
- Every other runner process is killed: at service start, on every switch change, and once a minute.
- A supervisor whose thread is alive but holds no live runner is "stuck". The minute guard restarts
  it.
- Debug builds can force that case: `--ez break true` on the `MESSAGING` action.

## Signing

`debug.keystore` is the standard throwaway Android debug key (alias `androiddebugkey`, passwords
`android`). It is committed on purpose, so that every build, from CI or from a computer, has the
same signature and a newer build installs over an older one without wiping the app's data. It is
not a release key and protects nothing.

## Building

The APK is built in CI (`.github/workflows/android-app.yml`). The workflow runs on changes to
`android/` and `app/`, and:

- takes the node from the latest successful `native-build` run on `main` and checks it against its
  `SHA256SUMS`
- runs the unit tests (`testDebugUnitTest`), then builds the debug APK, with `app/` as it is in
  that commit
- checks the APK:
  - the node library is present for arm64-v8a with the expected hash
  - the web app files are identical to `app/`
  - Python is included
  - the manifest has the service, its foreground type, the permissions, and the wallet's separate
    process
- uploads the APK as a workflow artifact, and nowhere else

To build it on a computer (JDK 17, Android SDK platform 36 and build-tools 36.0.0, Gradle 8.14; no
Python needed), copy the node binary to `app/src/main/jniLibs/arm64-v8a/liblogosnode.so`, then, in
`android/`:

```sh
gradle --no-daemon assembleDebug -PnodeVersion=0.3.4 -PnodeSha256=<sha256 of the binary>
```

## Background limits on ordinary phones

Android's "phantom process" killer stops an app's child processes when they use a lot of CPU while
the app is in the background, and the node is such a child process. The test phone has "Disable
child process restrictions" switched on in the developer options; ordinary phones do not. On an
ordinary phone, expect this: the node dies after a while with the screen off or the app in the
background, the log shows `[app] node exited (exit code …); restarting in …`, and the service keeps
restarting it. Whether that leaves the node usable has not been tested.

Some manufacturers add their own battery limits on top of this. Exempting the app from battery
optimisation may help there; this build does not ask for that.
