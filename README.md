# Logos node on an Android phone

Run the official [Logos blockchain node](https://github.com/logos-blockchain/logos-blockchain) on an Android phone, inside Android's built-in Linux Terminal. Nothing is cross-compiled: it's the unmodified `linux-aarch64` release binary.

Unofficial community work. Testnet only.

## Status

Tested on one phone: Pixel 8 (8 GB RAM), Android 17, node 0.3.4.

| | |
|---|---|
| Node starts, makes keys, joins the testnet | works |
| Syncs and verifies blocks | works, about 600 to 800 blocks a minute on one core |
| Survives the screen sleeping (on the charger) | works |
| Web page on the phone reads the local node | works (status page on `127.0.0.1:8090`) |
| Full sync from the first block | **not finished yet**, see Memory below |
| `install.sh` on a fresh phone | **not tested yet**; it's assembled from the steps that worked by hand |

## What you need

- A phone with Android's Linux Terminal ("Linux development environment" in Developer options). Today that means recent Pixels and a few other devices.
- About 8 GB of RAM, a charger, and Wi-Fi.
- A few GB of free storage.

Other Android phones don't have the Linux Terminal. The same binary should run under Termux with a proot Ubuntu 24.04 (it needs glibc 2.38 or newer), but that is untested here.

## Install

1. Settings → System → Developer options → **Linux development environment** → on. Open the **Terminal** app and let it install.
2. Terminal → gear → Advanced → **Memory size**: about 4000 MB on an 8 GB phone. Don't set the maximum (see Memory).
3. In the Terminal, run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/jefdiesel/logos-node-android/main/install.sh | sh
   ```

4. Terminal → gear → **Port control** → allow **8090**. Leave 8080 off.
5. Open `http://127.0.0.1:8090` in the phone's browser.

The script downloads the node from the official releases, creates fresh keys, writes a testnet config, adds swap space, and installs two services so the node and the status page start whenever the Linux box starts. Mining is off.

The Linux box only runs while the Terminal app is alive. If Android closes the app, open it again and the node starts by itself.

## Memory

This is the main limit.

- While it syncs from the first block, the node's memory grows with the chain: about 2 GB at block 32,000, roughly 57 MB per 1,000 blocks.
- With the Linux box set to the maximum (5.3 GB of the phone's 7.7 GB), Android ran short of memory and its low-memory killer closed the Terminal app, and the node with it, at about block 33,000.
- At 4 GB plus swap inside the box, Android keeps more for itself. Whether a full sync completes this way is still being tested.
- Every restart replays all stored blocks before the node answers again (17,211 blocks took 12.5 minutes), so restarts are expensive while it syncs.

## Security

- The node's own API (port 8080) answers any website by default (`access-control-allow-origin: *`), including its wallet endpoints. **Don't allow 8080 in Port control.** If you need the API from your own web app, start the node with `--http-cors-origin <your site>`.
- The status page on 8090 passes only two read-only calls (`/cryptarchia/info`, `/network/info`) and nothing else.
- The script makes new keys on the phone. Don't copy keys from another node onto it.

## Files

- `install.sh`: the installer described above.
- `apiproxy.py`: the read-only status page and proxy. The installer embeds a copy.

## Uninstall

In the Terminal: `sudo systemctl disable --now logos-node logos-node-status`, then delete `~/node`. Or wipe the whole Linux box with Terminal → gear → Recovery.
