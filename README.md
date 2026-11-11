# Logos node on an Android phone

Run the official [Logos blockchain node](https://github.com/logos-blockchain/logos-blockchain) on an Android phone. Nothing is cross-compiled: it's the unmodified `linux-aarch64` release binary, with a small status page you open in the phone's browser.

There are two ways to run it:

- **Linux Terminal** (Android's built-in Linux box): the better route, on phones that have it. See the [device list](#which-phones-have-the-linux-terminal).
- **Termux**: for every other 64-bit ARM phone. See [Termux](#termux-for-phones-without-the-linux-terminal).

Unofficial community work. Testnet only.

[![install-test](https://github.com/jefdiesel/logos-node-android/actions/workflows/install-test.yml/badge.svg)](https://github.com/jefdiesel/logos-node-android/actions/workflows/install-test.yml)

## Status

Tested by hand on one phone: Pixel 8 (8 GB RAM), Android 17, node 0.3.4, Linux Terminal.

| | |
|---|---|
| Node starts, makes keys, joins the testnet | works on the Pixel 8 |
| Syncs and verifies blocks | works, about 600 to 800 blocks a minute on one core |
| Survives the screen sleeping (on the charger) | works |
| Web page on the phone reads the local node | works (status page on `127.0.0.1:8090`) |
| Full sync from the first block | **not finished yet**, see [Memory](#memory) |
| `install.sh` on a clean machine | passes in CI on a clean arm64 Linux machine (installs, starts, syncs blocks). Not yet run on a freshly reset phone |
| `install-termux.sh` | passes in CI inside the official Termux Docker image (installs, node syncs blocks). **Not yet run on a real phone** |

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

1. Settings → System → Developer options → **Linux development environment** → on. Open the **Terminal** app and let it install.
2. Terminal → gear → Advanced → **Memory size**: about 4000 MB on an 8 GB phone. Don't set the maximum (see [Memory](#memory)).
3. In the Terminal, run:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/jefdiesel/logos-node-android/main/install.sh && sh install.sh
   ```

4. Terminal → gear → **Port control** → allow **8090**. Leave 8080 off.
5. Open `http://127.0.0.1:8090` in the phone's browser.

The script downloads the node from the official releases, creates fresh keys, writes a testnet config, adds swap space, and installs two services so the node and the status page start whenever the Linux box starts. Mining is off.

The Linux box only runs while the Terminal app is alive. If Android closes the app, open it again and the node starts by itself.

## Termux (for phones without the Linux Terminal)

Termux is a terminal app that works on almost any Android phone. It can't run the official node directly, because the node is built for normal Linux, so the script installs a small Ubuntu inside Termux (with `proot-distro`) and runs the node there. No root is needed.

**This route passes an automated test in the Termux Docker image, but nobody has run it on a real phone yet.** If you try it, please open an issue and say how it went.

1. Install **Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) or its [GitHub releases](https://github.com/termux/termux-app/releases). The Play Store version is different and out of date.
2. In Termux, run:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/jefdiesel/logos-node-android/main/install-termux.sh && sh install-termux.sh
   ```

3. Start the node with `~/logos-node`. Keep Termux open. Ctrl-C stops the node.
4. Open `http://127.0.0.1:8090` in the phone's browser. There's no Port control step here.

What to expect on a real phone. These are known Termux behaviours, not things measured here:

- **Android may kill it.** Android 12 and later kills background work that apps like Termux start (you'll see `[Process completed (signal 9)]`). On Android 14 and later, turn on Developer options → **Disable child process restrictions**. Also set Termux's battery use to Unrestricted and keep the phone on a charger.
- **Memory is tighter.** There's no swap without root, so the [memory limit](#memory) below applies with less room.
- **It's slower.** `proot` adds overhead to every file and network call.
- **No auto-start.** After a reboot, open Termux and run `~/logos-node` again.

## Memory

This is the main limit, on either route.

- While it syncs from the first block, the node's memory grows with the chain: about 2 GB at block 32,000, roughly 57 MB per 1,000 blocks.
- With the Linux box set to the maximum (5.3 GB of the phone's 7.7 GB), Android ran short of memory and its low-memory killer closed the Terminal app, and the node with it, at about block 33,000.
- At 4 GB plus swap inside the box, Android keeps more for itself. Whether a full sync completes this way is still being tested.
- Every restart replays all stored blocks before the node answers again (17,211 blocks took 12.5 minutes), so restarts are expensive while it syncs.

## Security

- By default the node's own API (port 8080) answers any website (`access-control-allow-origin: *`), including its wallet endpoints. Both installers start the node with `--http-cors-origin http://127.0.0.1:8090`, so it only accepts the local status page. CI checks this.
- On the Linux Terminal route, **don't allow 8080 in Port control**. On the Termux route there is no Port control: the node's API sits on the phone's own `127.0.0.1`, so the setting above is what keeps other websites out.
- The status page on 8090 passes only two read-only calls (`/cryptarchia/info`, `/network/info`) and nothing else.
- The scripts make new keys on the phone. Don't copy keys from another node onto it.

## Files

- `install.sh`: installer for the Linux Terminal.
- `install-termux.sh`: installer for Termux.
- `apiproxy.py`: the read-only status page and proxy. Both installers embed a copy.
- `.github/workflows/install-test.yml`: runs both installers on clean arm64 machines.

## Uninstall

- Linux Terminal: `sudo systemctl disable --now logos-node logos-node-status`, then delete `~/node`. Or wipe the whole Linux box with Terminal → gear → Recovery.
- Termux: `proot-distro remove ubuntu` and delete `~/logos-node`.
