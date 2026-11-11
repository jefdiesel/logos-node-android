# Wallet backup

## What the backup file is

Your node's wallet keys are kept in one file on the phone, `keystore.yaml`, next to the node's
settings (`~/node/run/keystore.yaml`, or `/root/node/run/keystore.yaml` inside the Termux Ubuntu).
Whoever has that file controls the coins on those keys.

There is no seed phrase in this wallet: the key file holds several independent keys, not keys derived
from one seed, so the backup file is what takes a seed phrase's place.

**Back up wallet** in the web app saves an encrypted copy of that file, named
`logos-node-wallet-backup-YYYYMMDD.json`. It goes to the phone's Downloads folder.

- The file is locked with the **backup password** you chose when you made it. Your PIN is not used for it.
  It must be at least 8 characters. Longer is safer: anyone who gets the file can try passwords against it
  without limit, so 12 or more characters, or four random words, is a better choice. **Show** lets you see
  what you type; while it is shown you type it once, otherwise twice.
- Anyone who has the file *and* the password controls the wallet. Keep the two apart.
- If the password is lost, the file can't be opened. Nobody can recover it, including this app.
- Move the file off the phone, for example to a USB stick or a computer you trust. A backup that only lives
  on the phone is lost with the phone.
- The file also lists the wallet's public addresses, unencrypted, so you can see which wallet a file belongs to.

## Restoring in the app

Restoring **replaces the node's keys** with the ones in the backup. Any coins on the keys the node has now
are only reachable through those keys. If they hold anything, back them up first.

In the unlocked wallet, tap **Restore from a backup file** and choose the file. The app shows the
addresses written on the file next to the wallet's current ones, and says plainly if the current keys
have never been backed up. Enter the backup password and your PIN, tick the box, and tap **Replace the keys**.

Before it changes anything, the app opens the file and has the node itself check the key file in it.
It only goes ahead if the node accepts it and reports the same addresses as the file. It then keeps the
old key file next to the new one as `keystore.yaml.replaced-<date and time>` (only you can read it),
puts the new one in place and restarts the node:

- Android Linux Terminal: the app restarts the node itself.
- Termux: the app can't restart the node there. It tells you to press Ctrl-C where the node runs and
  start it again with `~/logos-node`.

Your PIN, fingerprint unlock and the app's event log stay as they are. The history starts tracking the
restored keys from that moment. If the file holds the keys already in use, nothing changes.

## Restoring by hand

You don't need the app for this, so you never depend on it to get your keys back.

You need Python 3 and the `cryptography` package (`pip install cryptography`) on the machine where you
open the file. On the phone's Linux Terminal that is `sudo apt install python3-cryptography`.

1. Get the opener, `tools/decrypt-backup.py` from this repository:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/jefdiesel/logos-node-android/main/tools/decrypt-backup.py
   ```

2. Open the backup. It asks for the backup password and writes `keystore.yaml` into the current folder:

   ```sh
   python3 decrypt-backup.py logos-node-wallet-backup-20261111.json
   ```

   "wrong password, or the file has been changed or damaged" means exactly that. Nothing is written.

3. Stop the node, put the file next to the node's settings, and start the node again.

   Android Linux Terminal:

   ```sh
   sudo systemctl stop logos-node
   mv ~/node/run/keystore.yaml ~/node/run/keystore.yaml.old    # only if there is one
   cp keystore.yaml ~/node/run/keystore.yaml && chmod 600 ~/node/run/keystore.yaml
   sudo systemctl start logos-node
   ```

   Termux: stop the node with Ctrl-C, then:

   ```sh
   proot-distro login ubuntu
   mv /root/node/run/keystore.yaml /root/node/run/keystore.yaml.old    # only if there is one
   cp /path/to/keystore.yaml /root/node/run/keystore.yaml && chmod 600 /root/node/run/keystore.yaml
   exit
   ~/logos-node
   ```

   On another machine, put `keystore.yaml` in the same folder as the node's `user_config.yaml` and start the node.

4. Open the web app. The wallet shows the restored addresses once the node has synced. Delete the
   decrypted `keystore.yaml` copy you made in step 2, since it is not encrypted.

## The format, for other tools

The file is JSON:

| field | meaning |
|---|---|
| `format`, `version` | `"logos-node-wallet-backup"`, `1` |
| `created` | when it was made, UTC |
| `addresses` | the wallet's public keys with their labels (not secret) |
| `kdf` | `{"name": "scrypt", "n": 65536, "r": 8, "p": 1, "dklen": 32, "salt": base64}` |
| `cipher` | `{"name": "chacha20-poly1305", "nonce": base64 (12 bytes), "aad": "logos-node-wallet-backup v1"}` |
| `ciphertext` | base64 of the ChaCha20-Poly1305 (RFC 8439) ciphertext followed by its 16-byte tag |

The key is scrypt of the password's UTF-8 bytes, exactly as typed, with the parameters above. The
associated data is the ASCII text `logos-node-wallet-backup v1`. The decrypted text is a JSON object
`{"keystore.yaml": "<the file's text>"}`.
