# Logos node: minimal Android app (test build)

A small Android app that runs the official Logos node inside the app, to find out whether the node
works in an app's sandbox. It is a debug build for testing, not something to publish.

- Package `io.github.jefdiesel.logosnode`, name "Logos node", arm64 phones only, Android 9 (API 28)
  or newer.
- The node is the binary from the `native-build` workflow (see `native/README.md`), bundled as it
  is, not rebuilt. The APK carries it as `lib/arm64-v8a/liblogosnode.so`. Android extracts that at
  install to the app's native library folder. Android only lets an app run programs from there, not
  from its data folder.
- The screen shows the node version and binary hash the APK carries, and so does the first log line
  of every start.

## What it does

- **Start** starts a foreground service, which shows a permanent notification and runs the node as a
  child process.
- **Stop**, on the screen or in the notification, stops the node (SIGTERM, then SIGKILL after 20 s)
  and the service.
- If the node exits on its own, the service restarts it after 5 s. The wait doubles on each restart,
  up to 5 minutes, and goes back to 5 s after a run of more than 10 minutes.
- The service holds a partial wake lock while it runs, so the node keeps up with its peers when the
  screen is off.
- **Foreground service type `specialUse`.** It is the only type with no time limit: `dataSync`, for
  example, is capped at 6 hours a day on Android 15 and later.
- **First start.** The service runs the node's own `init-config`, which creates fresh keys
  (`keystore.yaml`). Then it writes `user_config.yaml` in the same shape as `install.sh`: the four
  testnet initial peers, the API on `127.0.0.1:18180`, and the log and state folders inside the app.
  The config is rewritten on every start; the keys are kept.
- **The screen** has Start and Stop, and shows whether the node process is running and how much
  memory it uses. Every 3 seconds it reads block height, state, phase and peer count from the
  node's API, and it shows the last 40 lines of the log.
- **Network.** Cleartext HTTP is allowed to `127.0.0.1` only (`network_security_config.xml`). The app
  makes no network connections other than the node's own.
- **Full sync.** This build syncs from the first block, and that cannot finish on a phone: the
  node's memory grows with the chain during the first sync. Starting from a snapshot is a later step.

## Files on the phone

Everything is under the app's own storage, `/data/data/io.github.jefdiesel.logosnode/files/node/`:

| path | what |
|---|---|
| `output.log` | the node's stdout and stderr, plus `[app]` lines from the service (starts, exits, restarts, node memory once a minute). Capped at 4 MB, then moved to `output.log.1` |
| `logs/` | the node's own log files (hourly, the node keeps 10) |
| `state/` | the node's database |
| `user_config.yaml`, `keystore.yaml` | config and keys |
| `tmp/` | `TMPDIR`; `HOME` is `files/node` itself |

The build is debuggable, so the files can be read from a computer:

```sh
adb shell run-as io.github.jefdiesel.logosnode tail -50 files/node/output.log
adb shell run-as io.github.jefdiesel.logosnode cat files/node/output.log > output.log
```

## Install and run from adb

```sh
adb install -r logos-node-0.3.4-debug.apk
# start the node (or open the app and press Start)
adb shell am start-foreground-service -n io.github.jefdiesel.logosnode/.NodeService -a io.github.jefdiesel.logosnode.START
# stop it
adb shell am startservice -n io.github.jefdiesel.logosnode/.NodeService -a io.github.jefdiesel.logosnode.STOP
```

The service is exported only to callers that hold `android.permission.DUMP`. The adb shell has that
permission and ordinary apps cannot get it, which is what makes the two `am` commands work.

## Signing

`debug.keystore` is the standard throwaway Android debug key (alias `androiddebugkey`, passwords
`android`). It is committed on purpose, so that every build, from CI or from a computer, has the
same signature and a newer build installs over an older one without wiping the app's data. It is
not a release key and protects nothing.

## Building

The APK is built in CI (`.github/workflows/android-app.yml`). The workflow:

- takes the node from the latest successful `native-build` run on `main` and checks it against its
  `SHA256SUMS`
- builds the debug APK
- checks the APK: the node library is present for arm64-v8a with the expected hash, native
  libraries are extracted at install, and the service, its foreground type and the permissions are
  in the manifest
- uploads the APK as a workflow artifact, and nowhere else

To build it on a computer instead (JDK 17, Android SDK platform 36 and build-tools 36.0.0, Gradle
8.14), copy the node binary to `app/src/main/jniLibs/arm64-v8a/liblogosnode.so`, then:

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
