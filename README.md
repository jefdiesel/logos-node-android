# Logos node on an Android phone

The official [Logos blockchain node](https://github.com/logos-blockchain/logos-blockchain), unmodified, running and fully synced on an Android phone (after starting from a copy of a synced node's database, [see below](#what-works-today)). It comes with a local web app that shows the node's status and is a wallet: unlock with a PIN or your fingerprint (it locks itself again when you stop using it), receive, send to an address or a name, see your history, back up and restore your keys, and update the app itself. You can add it to the home screen.

Nothing is cross-compiled: what runs on the phone is the unmodified `linux-aarch64` release binary of `logos-blockchain-node` 0.3.4, inside Android's built-in Linux Terminal. A *node* is the program that keeps a copy of the blockchain, checks every new *block* (a batch of transactions) and passes them on to other nodes.

<p>
<img src="docs/img/app-icon-on-home-screen.png" alt="A row of Android app icons; the middle one is the web app's black lambda on a cream circle" width="420"><br>
<img src="docs/img/lock-screen.png" alt="The app's lock screen in dark mode: the lambda mark, Enter PIN, an empty PIN row and a number keypad with a fingerprint key and a delete key" width="260">
</p>

Unofficial community work. Testnet only (the *testnet* is the public test network; its coins have no value).

[![install-test](https://github.com/jefdiesel/logos-node-android/actions/workflows/install-test.yml/badge.svg)](https://github.com/jefdiesel/logos-node-android/actions/workflows/install-test.yml)

## What works today

On the test phone (Pixel 8, 8 GB RAM, Android 17, Linux Terminal):

- The node is fully synced and **Online**, following the tip of the chain: block 82,869 when this was first checked, the same height as a desktop reference node, with 130+ peers (other nodes it is connected to).
- The wallet received real transfers, and the phone's node reported them. The first was 100,000 Logos sent from another node's wallet.
- The phone paid an LNS name (see [LNS names](#lns-names)): it looked the name up itself, showed the address, and its own node signed and sent 1,111 Logos. The receiving node, a separate desktop node, reported exactly that amount, and the phone's history recorded the send with the name and the fee.
- The fee was 2,298 for that payment, and also 2,298 for transfers of 100,000 and of about 111 million earlier the same day. On this testnet the fee did not depend on the amount.
- Name lookups on the phone gave the right answers: a registered name with no Logos Blockchain address set was reported as such, and a name pointing at the phone's own wallet resolved correctly; the app then refused to send, because the address was the same key the payment would come from.
- The web app updated itself four times through its update prompt, 0.7.0 → 0.7.1 → 0.7.2 → 0.7.3 → 0.7.4, keeping the PIN, the fingerprint key, the history and the event log each time.
- Fingerprint unlock is in daily use.

**The catch: the node got there by starting from a copy of an already-synced node's database, not by syncing from the first block.** Syncing from the first block ran out of memory on the phone (see [Why not sync from the first block](#why-not-sync-from-the-first-block)). This repo does not publish such a copy; [Starting from a synced node's database](docs/start-from-a-synced-database.md) describes the method, and what you have to trust to use it.

## Status

| | |
|---|---|
| Node runs, makes its own keys, joins the testnet | works on the test phone |
| Synced and Online, following the chain tip | works on the test phone, after a start from a synced node's database |
| Receives real transfers | works on the test phone |
| Web app: status, PIN, fingerprint unlock, history, home-screen icon | works on the test phone |
| Name lookup and send to a name | works on the test phone |
| Web app updates itself | works on the test phone (0.7.0 → 0.7.4, four updates) |
| Auto-lock (new in 0.7.4) | passes in CI. **Not yet verified on the phone** |
| Wallet backup and restore | pass in CI. **Not yet verified on the phone** |
| Full sync from the first block on a phone | **not done**: Android stopped the Linux box each time, see [below](#why-not-sync-from-the-first-block) |
| `install.sh` | passes in CI on a clean arm64 Linux machine. **Not yet run on a freshly reset phone** |
| `install-termux.sh` | passes in CI inside the Termux Docker image. **Never run on a real phone** |
| One-tap Android app | no. Setup is by hand, in a terminal |
| Native Android build of the node | builds in CI; ran for a few minutes on the test phone from a developer shell, not inside an app. Not published. See [Native build](#native-build-experimental) |

## Which phones have the Linux Terminal

To check your own phone: Settings → System → Developer options → **Linux development environment**. If that switch isn't there, use Termux.

There is no official list. This one is collected from press reports, as of November 2026, and it depends on the phone's chip:

| Chip | Phones reported working | Notes |
|---|---|---|
| Google Tensor (G1 and later) | Pixel 6 and later, Pixel Fold, Pixel Tablet | Where the feature started. **Pixel 8 tested here.** |
| Samsung Exynos 2500 / 2600 | Galaxy Z Flip 7; Galaxy S26 and S26+ (Exynos models, One UI 8.5) | Only the Exynos versions |
| MediaTek Dimensity 9400+ and later | Xiaomi 15T Pro | Other phones with these chips may work |
| Qualcomm Snapdragon | REDMAGIC 12 Pro (first one reported, November 2026) | Most Snapdragon phones don't: see below |

Reported **not** working: Galaxy S26 Ultra, Galaxy Z Fold 7, Xiaomi 17 Pro and other Snapdragon 8 Elite phones (the Terminal fails with "non-protected VMs are not supported on this device"), and older Galaxy phones such as the S23 Ultra.

You also need about 8 GB of RAM, a charger, Wi-Fi and a few GB of free storage.

Sources: [9to5Google on the first Snapdragon phone](https://9to5google.com/2026/11/04/the-first-snapdragon-phone-with-android-linux-terminal-support-is-here/), Android Authority on [Snapdragon chips](https://www.androidauthority.com/snapdragon-chips-android-linux-terminal-3608648), the [Galaxy Z Flip 7](https://www.androidauthority.com/galaxy-z-flip-7-linux-terminal-3578675), the [Galaxy S26](https://www.androidauthority.com/galaxy-s26-linux-terminal-3645822) and [One UI 8.5](https://www.androidauthority.com/samsung-phones-linux-terminal-one-ui-8-5-3652503).

## Install (Linux Terminal)

The Linux Terminal app runs a small Debian Linux system in a virtual machine (VM) on the phone, called "the Linux box" below.

1. Settings → System → Developer options → **Linux development environment** → on. Open the **Terminal** app and let it install. It asks for the microphone permission; the node doesn't need it.
2. Phone settings that turned out to matter on the test phone:
   - Developer options → **Disable child process restrictions** → on. Without it, Android killed the Terminal's Linux box for "excessive cpu" a few minutes after another app was put in front of it.
   - Terminal → gear → Advanced → **Keep awake** (it offers up to 1 day).
   - Terminal → gear → Advanced → **Memory size**: about **2500 MB** on an 8 GB phone. That left the phone about 1 GB free. At 4000 MB it had about 450 MB free, and Android killed the Linux box when another app opened.
3. In the Terminal, run:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/jefdiesel/logos-node-android/main/install.sh && sh install.sh
   ```

4. When the Terminal app offers to open port **8090** (the web app), allow it. The Terminal app asks about every TCP port from 1024 up that something in the Linux box listens on; the node's own API is on port 880, below that range, so it isn't offered. If it offers any other port, deny it. You can change this later under Terminal → gear → Port control.
5. Open **`http://localhost:8090`** in the phone's browser. Use `localhost`, not `127.0.0.1`: fingerprint unlock only works on `localhost`.

What `install.sh` does: downloads node 0.3.4 from the official releases, creates fresh keys, writes a testnet config with the node's API on `127.0.0.1:880` (the node gets the permission to use a port below 1024), adds a 2 GB swap file inside the Linux box, downloads the web app from this repository's `release` branch, and installs two services (`logos-node` and `logos-node-app`) so both start whenever the Linux box starts. Mining is off.

Then the node starts syncing from the first block, which is where the [memory limit](#why-not-sync-from-the-first-block) comes in. The test phone reached the chain tip by [starting from a synced node's database](docs/start-from-a-synced-database.md) instead.

Notes:

- The Linux box only runs while the Terminal app is alive. If Android closes the app, open it again and the node starts by itself.
- After changing a Terminal setting, the Terminal's own "Restart" left the port pass-through broken on the test phone (the page refused connections although Port control showed 8090 on). Fully closing the Terminal app and opening it again fixed it.
- Every time the node starts, it re-checks the blocks it stored since the last final block before it answers. After the snapshot start that was about 1,000 blocks, about a minute. While it waits, the web app shows how many blocks the node is re-checking.

## The web app

A small Python program (`app/server.py`, standard library only) and one page (`app/index.html`), served on port 8090 of the device itself. Version 0.7.4 at the time of writing.

- **Node status:** in plain words: how many blocks are on this device (and where the network is while it catches up), the state (Online, or Catching up), how many nodes it is connected to and how many new blocks arrive a minute.
- **PIN.** You choose a PIN (6 to 12 digits) on first use; it can't be recovered. Five wrong PINs pause unlocking for 5 minutes.
- **Auto-lock.** The wallet locks after 5 minutes without you using it (1, 5 or 15 in Settings), and one minute after you leave the page (switch to another app or turn the screen off), or when you tap **Lock wallet**. Only what you do counts as use: the page's own background refreshes don't keep it open.
- **Fingerprint unlock**, using a passkey (a login key the phone keeps and only releases after your fingerprint or screen lock). It only works when the page is opened as `http://localhost:8090`, and you need the PIN to turn it on. The PIN keeps working as a fallback.
- **Receive:** each of the wallet's keys is an address with a **Copy address** button, to give to whoever pays you. A popup tells you when coins arrive.
- **Send** (a button under the balances that opens the form) to a 64-character address or to an LNS name, with a review step. It won't send until the node is Online, won't send to the same key the coins come from, and shows the fee once the transfer is in a block.
- **History** (the button next to Send) of what came in and went out. The node keeps no history, so the app records it itself from the moment it first sees the node online; earlier activity isn't listed.
- **Settings** (the gear at the top): Updates, Back up wallet, Restore from a backup file, Fingerprint unlock, Auto-lock, About. The "No backup yet" and "Version … is available" notices open Settings at the right place. While the wallet is locked, only About is shown, and it says when a newer version exists.
- **Add to Home screen** in Chrome's menu, from `http://localhost:8090`. It gets its own lambda icon and opens without the browser bars.
- **Security event log:** unlocks and failed unlocks, PIN and fingerprint changes, locks (and why: by you, idle, or the page was left), auto-lock changes, sent transfers, backups, restores and updates are written to `wallet-events.log` next to the app, readable only by its owner and not over the web. It records which page asked, and never the PIN or keys.

Amounts are shown with "Logos" after them; they are the node's own whole numbers, not converted.

### LNS names

An LNS name is a short name like `alice`, registered with Logos Names on the Logos testnet. Its holder can attach a Logos Blockchain address to it, so you can pay the name instead of typing a 64-character address. The app looks the name up on the phone with the names project's reference resolver. The name itself never leaves the phone: only an identifier derived from it is sent to the name service. The wallet trusts the answer, so the review screen shows the address it found; for a large amount, check it with the person you're paying.

### Backup, restore and updates

- **Backup.** There is no seed phrase: the wallet holds several independent keys, so an encrypted backup file takes its place. **Back up wallet** saves the node's key file, locked with a backup password you choose (not your PIN; at least 8 characters, and the app advises 12 or more, or four random words; **Show** lets you see it while typing), to Downloads. Until you make one, the wallet shows "No backup yet". The file can be opened without the app, with [`tools/decrypt-backup.py`](tools/decrypt-backup.py). **Restore from a backup file** replaces the node's keys with the ones in a file. Details, risks and the file format: [docs/backup.md](docs/backup.md).
- **Updates.** The app checks this repository's `release` branch when it starts, every 6 hours, and when you tap **Check for updates**. That branch only moves to a version after every CI job has passed. Updating needs the wallet unlocked and your PIN, or a fresh fingerprint confirmation. The app checks every downloaded file against the release list before using it, keeps the previous version for going back by hand, and never restarts the node. Details: [docs/updating.md](docs/updating.md).

The wallet's keys live in the node, not in the web app: the app reads the public keys from the node's config and asks the node to make transfers. The wallet only answers requests addressed to the device itself (`localhost` or `127.0.0.1`), and it only accepts changes from its own page.

## Why not sync from the first block

Measured on the test phone:

- During the first catch-up, the node's memory grows with the chain: about 57 MB per 1,000 blocks (2.0 GB at block 32,000), which projects to about 4.7 GB at block 82,000.
- Once synced, the same node needs far less. A desktop reference node that had been up 8 days used 927 MB, and the phone's node settled around 1.4 to 1.6 GB.
- Android stopped the Linux box three times before a sync could finish: its low-memory killer with the box set to 5.3 GB (the most the Terminal app offered), the low-memory killer again at 4 GB when Chrome was opened, and once a background "excessive cpu" kill of the Terminal app's child process four minutes after another app was put in front of it.
- Every restart replays all blocks stored since the last *final* block (one the network has settled for good) before the node answers again. 17,211 blocks took 12.5 minutes, and a replay of 33,003 blocks never finished before the next kill.

Our explanation: during the first catch-up nothing becomes final, so the node releases nothing, and both its memory and the replay after a restart keep growing. **This is an inference from these measurements, not something confirmed in the node's source.**

Syncing on one core ran at about 600 to 800 blocks a minute while it lasted. More measurements are in [docs/sync-on-a-phone.md](docs/sync-on-a-phone.md).

## Termux (for phones without the Linux Terminal)

Termux is a terminal app that works on almost any Android phone. It can't run the official node directly, because the node is built for normal Linux, so the script installs a small Ubuntu inside Termux (with `proot-distro`) and runs the node there. No root is needed.

**This route passes an automated test in the Termux Docker image, but it has never run on a real phone.** If you try it, please open an issue and say how it went. The same [memory limit](#why-not-sync-from-the-first-block) applies, with less room.

1. Install **Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) or its [GitHub releases](https://github.com/termux/termux-app/releases). The Play Store version is different and out of date.
2. In Termux, run:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/jefdiesel/logos-node-android/main/install-termux.sh && sh install-termux.sh
   ```

3. Start the node with `~/logos-node`. It starts the web app too and takes a wake lock if `termux-wake-lock` is available. Keep Termux open. Ctrl-C stops the node.
4. Open `http://localhost:8090` in the phone's browser. There's no Port control step here, and the node's API stays on port 8080. Fingerprint unlock has not been tried on this route. After a restore, the app can't restart the node here: it tells you to press Ctrl-C and run `~/logos-node` again.

What to expect on a real phone. These are known Termux behaviours, not things measured here:

- **Android may kill it.** Android 12 and later kills background work that apps like Termux start (you'll see `[Process completed (signal 9)]`). On Android 14 and later, turn on Developer options → **Disable child process restrictions**. Also set Termux's battery use to Unrestricted and keep the phone on a charger.
- **Memory is tighter.** There's no swap without root.
- **It's slower.** `proot` adds overhead to every file and network call.
- **No auto-start.** After a reboot, open Termux and run `~/logos-node` again.

## Security

- By default the node's own API answers any website (`access-control-allow-origin: *`), including its wallet endpoints. Both installers start the node with `--http-cors-origin http://127.0.0.1:8090`, so browsers let no other website read it. CI checks this.
- On the Linux Terminal route the node's API is on port 880, which the Terminal app never offers to open; don't open it under Port control. On the Termux route there is no Port control: the API sits on the phone's own `127.0.0.1:8080`.
- The web app listens on `127.0.0.1` only. Besides its own page and the wallet calls, it passes on just two read-only node calls (`/cryptarchia/info`, `/network/info`).
- The web app itself reaches out to exactly two places, over HTTPS: this repository's `release` branch on GitHub, for updates, and the name service, for one read per name lookup. The page's footer and Settings → About say the same.
- The scripts make new keys on the phone. Don't copy keys from another node onto it, except your own through **Restore from a backup file**.
- If you start from someone else's database, you rely on them for the chain history up to that point. See [the trust note](docs/start-from-a-synced-database.md#what-you-are-trusting).

## Tests

None of these run on a phone. The [`install-test`](.github/workflows/install-test.yml) workflow runs on arm64 Linux machines:

- `fresh-install`: runs `install.sh` on a clean machine and checks both services, the page, that the node syncs blocks from the testnet, that the node's API is on port 880 and refuses other websites, the wallet's locks, the backup and its independent opener, a restore on the real node, and an in-app update under systemd.
- `app-update`: the release list matches the app files and both installers, the page's script parses, an update applies in place, and auto-lock works (idle time, leaving the page, the setting; with the timings shortened to seconds).
- `wallet-send`: a real transfer through the web app on a private one-node chain, checking both balances; then the name resolver against the names project's test vectors, and lookups and a send to a name through the app, against a stand-in name service.
- `termux`: runs `install-termux.sh` inside the Termux Docker image and checks that the node syncs blocks and the page answers.
- `promote`: once all four pass on `main`, moves the `release` branch (where phones get updates) to that commit.

The latest `install-test` run on `main`, for app version 0.7.4, passed all five jobs, and `release` points at that commit. The runs for 0.7.2 and 0.7.3 passed too. Several earlier runs on 11 November 2026 failed while the app and installers were being changed, the last of them for the installer change. The latest finished `native-build` run on `main` passed.

## Native build (experimental)

[`native/README.md`](native/README.md) describes a build of the official node source for Android itself (arm64, with the Android NDK), with no changes to the source. It runs in CI ([`native-build`](.github/workflows/native-build.yml)) and passes. The result exists only as a workflow artifact: it is **not published as a download**.

Tried once on the test phone, run from the Android shell over adb (not as an installed app): the binary reported its target as `aarch64-linux-android`, connected to 129 peers and synced from block 0 to 1,568 in about two and a half minutes at 211 MB of memory, then was stopped.

Not verified: running inside an app, proof generation on the phone, a long run, other phones.

## Not done or not verified

- The installers have not been run on a freshly reset phone.
- The Termux route has never run on a real phone.
- A full sync from the first block has not completed on a phone. The test phone's node started from a copy of a synced node's database.
- On the phone, these have not been done yet (they pass in CI where CI covers them): exporting a backup, restoring from one, confirming an update with the fingerprint, auto-lock when the page is left or the screen turns off, and Show/Hide on the backup password.
- Nothing here is a one-tap app; setup is by hand in a terminal.
- The native build has only run for a few minutes, from a developer shell, on one phone. It is not an app and not a download.
- Why memory grows during the first catch-up is our inference, not confirmed in the node's source.

## Files

- `install.sh`: installer for the Linux Terminal.
- `install-termux.sh`: installer for Termux.
- `app/`: the web app (`server.py`, `index.html`, `release.json`, and `names/`, the vendored names resolver). Both installers download it from the `release` branch.
- `tools/decrypt-backup.py`: opens a wallet backup without the app. `tools/release.py`: makes and checks app releases.
- `tests/`: the checks used in CI.
- `native/`: the native Android build.
- `docs/`: [backup](docs/backup.md), [updating](docs/updating.md), the [snapshot start method](docs/start-from-a-synced-database.md) and the [sync measurements](docs/sync-on-a-phone.md).

## Uninstall

- Linux Terminal: `sudo systemctl disable --now logos-node logos-node-app`, then delete `~/node`. Or wipe the whole Linux box with Terminal → gear → Recovery. Back up the wallet first if it holds anything.
- Termux: `proot-distro remove ubuntu` and delete `~/logos-node`.
